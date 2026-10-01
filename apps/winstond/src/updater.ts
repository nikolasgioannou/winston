/**
 * Self-update (docs/design.md §10): winstond replaces the CLI and itself with
 * the binaries in an `update.available` frame, and never installs one whose
 * hash or signature doesn't check out.
 *
 * Both binaries live in winstond's own directory, which it owns, so it needs
 * no privileges (`/usr/local/bin/winston` links to the CLI there). A swap is
 * atomic: the new file is written next to the old one and renamed over it,
 * so a running command keeps the old inode and nothing ever sees half a file.
 *
 * Replacing winstond itself keeps the old binary as `winstond.previous` and
 * writes `update-pending` (the new version) before exiting; systemd starts
 * the new one. If it fails to start three times, the unit's pre-start script
 * (image/scripts/winstond.sh) puts the previous binary back and renames the
 * marker to `update-failed`, so that version isn't tried again (it counts
 * starts in `update-pending.starts`). A new
 * winstond that connects removes the marker (`confirmUpdate`).
 */
import type { UpdateAvailableFrame } from "@winston/domain/frames";
import { createHash, verify } from "node:crypto";
import { readFile, rename, rm, writeFile, copyFile } from "node:fs/promises";
import { join } from "node:path";

export interface UpdaterOptions {
  /** winstond's directory: /usr/local/lib/winstond. */
  dir: string;
  publicKeyPem: string;
  versions: { winstond: string; cli: string | null };
  fetchImpl?: typeof fetch;
}

/** Whether a binary is the one that was signed: its SHA-256, then the signature. */
export function verifyBinary(
  bytes: Uint8Array,
  sha256: string,
  signatureBase64: string,
  publicKeyPem: string,
) {
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== sha256) return false;
  // KMS signed the digest (ECDSA_SHA_256); this hashes the bytes the same way.
  return verify(
    "sha256",
    bytes,
    publicKeyPem,
    Buffer.from(signatureBase64, "base64"),
  );
}

/** Replaces `path` with `bytes` atomically, executable. */
export async function swapInto(path: string, bytes: Uint8Array) {
  const temporary = `${path}.new-${String(process.pid)}`;
  await writeFile(temporary, bytes, { mode: 0o755 });
  await rename(temporary, path);
}

const pendingMarker = (dir: string) => join(dir, "update-pending");
const failedMarker = (dir: string) => join(dir, "update-failed");

/** The version whose winstond failed to start and was rolled back, if any. */
async function failedVersion(dir: string) {
  return (await readFile(failedMarker(dir), "utf8").catch(() => "")).trim();
}

/** Called once a winstond has connected: an update that got this far worked. */
export async function confirmUpdate(dir: string) {
  await rm(pendingMarker(dir), { force: true });
  await rm(`${pendingMarker(dir)}.starts`, { force: true });
}

export class UpdateRejectedError extends Error {}

/**
 * Applies an update: the CLI if its version differs, then winstond if its
 * does (and that version hasn't already failed here). Returns what changed;
 * when winstond changed, the caller exits so systemd starts the new one.
 */
export async function applyUpdate(
  frame: Pick<UpdateAvailableFrame, "version" | "binaries">,
  { dir, publicKeyPem, versions, fetchImpl = fetch }: UpdaterOptions,
) {
  const download = async (name: "winston" | "winstond") => {
    const binary = frame.binaries[name];
    const response = await fetchImpl(binary.url, {
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok)
      throw new Error(`downloading ${name} failed: ${String(response.status)}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!verifyBinary(bytes, binary.sha256, binary.signature, publicKeyPem))
      throw new UpdateRejectedError(
        `${name} ${frame.version} failed verification; not installing it`,
      );
    return bytes;
  };

  let cliUpdated = false;
  if (versions.cli !== frame.version) {
    await swapInto(join(dir, "winston"), await download("winston"));
    cliUpdated = true;
  }

  let winstondUpdated = false;
  if (
    versions.winstond !== frame.version &&
    (await failedVersion(dir)) !== frame.version
  ) {
    const bytes = await download("winstond");
    const current = join(dir, "winstond");
    await copyFile(current, join(dir, "winstond.previous"));
    await writeFile(pendingMarker(dir), frame.version);
    await rm(`${pendingMarker(dir)}.starts`, { force: true });
    await swapInto(current, bytes);
    winstondUpdated = true;
  }
  return { cliUpdated, winstondUpdated };
}
