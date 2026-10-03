import type { GatewayToVmFrame } from "@winston/domain/frames";
import { newFrameId } from "@winston/domain/frames";
import { isOutdated } from "@winston/domain/vm-versions";
import type { Logger } from "@winston/shared/logger";

/** One published binary: its key in the artifacts bucket, and how to check it. */
interface ManifestBinary {
  key: string;
  sha256: string;
  signature: string;
}

/**
 * The current VM binaries, `vm/latest.json` in the artifacts bucket
 * (scripts/publish-vm-binaries.ts writes it last, after the binaries).
 */
export interface VmManifest {
  version: string;
  binaries: { winston: ManifestBinary; winstond: ManifestBinary };
}

export interface UpdatesOptions {
  /** The manifest, or undefined when there isn't one (local development). */
  loadManifest: () => Promise<VmManifest | undefined>;
  /** A short-lived download URL for a key in the artifacts bucket. */
  presign: (key: string) => Promise<string>;
  /** Sends a frame to a VM's live connection; false if it isn't connected. */
  send: (vmId: string, frame: GatewayToVmFrame) => boolean;
  logger: Logger;
  /** How long agent work waits for a VM's CLI to catch up, once per version. */
  holdMs?: number;
}

/**
 * Keeps VMs on the current binaries (docs/design.md §10, Updates happen in
 * place): offers `update.available` to a VM whose `hello` reports older ones,
 * and to every connected VM when a deploy publishes new ones. Until a VM's
 * CLI is current, its exec work waits (`ready`), so the system prompt and the
 * CLI's `--help` agree; after `holdMs` the work goes ahead on the old CLI
 * with a warning, rather than wedging the user, and that VM's later work
 * doesn't wait again for the same version.
 */
export function createUpdates({
  loadManifest,
  presign,
  send,
  logger,
  holdMs = 60_000,
}: UpdatesOptions) {
  let manifest: VmManifest | undefined;
  /** What each connected VM last said it runs. */
  const reported = new Map<
    string,
    { cliVersion: string | null; winstondVersion: string }
  >();
  /** Work waiting for a VM's CLI to be current. */
  const waiters = new Map<string, Set<() => void>>();
  /** The version each VM already kept work waiting for, in vain. */
  const waited = new Map<string, string>();

  const cliCurrent = (vmId: string) => {
    const versions = reported.get(vmId);
    return (
      !manifest ||
      !versions ||
      !isOutdated(versions.cliVersion, manifest.version)
    );
  };

  const release = (vmId: string) => {
    for (const resolve of waiters.get(vmId) ?? []) resolve();
    waiters.delete(vmId);
  };

  const offer = async (vmId: string) => {
    const current = manifest;
    const versions = reported.get(vmId);
    if (!current || !versions) return;
    const outdated =
      isOutdated(versions.cliVersion, current.version) ||
      isOutdated(versions.winstondVersion, current.version);
    if (!outdated) return;
    const binary = async ({ key, sha256, signature }: ManifestBinary) => ({
      url: await presign(key),
      sha256,
      signature,
    });
    const sent = send(vmId, {
      id: newFrameId(),
      type: "update.available",
      version: current.version,
      binaries: {
        winston: await binary(current.binaries.winston),
        winstond: await binary(current.binaries.winstond),
      },
    });
    if (sent)
      logger.info(
        { vmId, from: versions, to: current.version },
        "offered a VM update",
      );
  };

  const offerLogged = (vmId: string) => {
    offer(vmId).catch((error: unknown) => {
      logger.error({ err: error, vmId }, "offering a VM update failed");
    });
  };

  return {
    /** Reads the manifest; a new version is offered to every connected VM. */
    async refresh() {
      const latest = await loadManifest();
      if (!latest || latest.version === manifest?.version) return;
      manifest = latest;
      logger.info({ version: latest.version }, "VM binaries published");
      for (const vmId of reported.keys()) offerLogged(vmId);
    },

    /** A VM said hello (on connecting, and again after updating its CLI). */
    hello(
      vmId: string,
      versions: { cliVersion: string | null; winstondVersion: string },
    ) {
      reported.set(vmId, versions);
      if (cliCurrent(vmId)) release(vmId);
      offerLogged(vmId);
    },

    disconnected(vmId: string) {
      reported.delete(vmId);
    },

    /** Resolves when the VM's CLI is current, or after `holdMs` at most. */
    async ready(vmId: string) {
      if (cliCurrent(vmId) || waited.get(vmId) === manifest?.version) return;
      const updated = await new Promise<boolean>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          resolve(true);
        };
        const timer = setTimeout(() => {
          waiters.get(vmId)?.delete(done);
          resolve(false);
        }, holdMs);
        const set = waiters.get(vmId) ?? new Set();
        set.add(done);
        waiters.set(vmId, set);
      });
      if (!updated && manifest) {
        waited.set(vmId, manifest.version);
        logger.warn(
          { vmId, versions: reported.get(vmId), current: manifest.version },
          "the VM's CLI didn't update in time; running on the old one",
        );
      }
    },
  };
}

export type Updates = ReturnType<typeof createUpdates>;
