import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  UpdateRejectedError,
  applyUpdate,
  confirmUpdate,
  verifyBinary,
} from "./updater.ts";

// A stand-in for the KMS key: same curve and algorithm.
const { privateKey, publicKey } = generateKeyPairSync("ec", {
  namedCurve: "P-256",
});
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });

const signed = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  return {
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    signature: sign("sha256", bytes, privateKey).toString("base64"),
  };
};

/** winstond's directory with the current binaries in it. */
async function installed() {
  const dir = await mkdtemp(join(tmpdir(), "winstond-"));
  await writeFile(join(dir, "winston"), "old cli");
  await writeFile(join(dir, "winstond"), "old winstond");
  return dir;
}

/** An update frame for `version`, served by a fake fetch. */
function release(version: string, cli = "new cli", daemon = "new winstond") {
  const files = { winston: signed(cli), winstond: signed(daemon) };
  const fetchImpl = ((url: string) =>
    Promise.resolve(
      new Response(
        files[url.endsWith("winston") ? "winston" : "winstond"].bytes,
      ),
    )) as unknown as typeof fetch;
  const frame = {
    version,
    binaries: {
      winston: {
        url: "https://s3/winston",
        ...files.winston,
        bytes: undefined,
      },
      winstond: {
        url: "https://s3/winstond",
        ...files.winstond,
        bytes: undefined,
      },
    },
  };
  return { frame, fetchImpl, files };
}

describe("verifyBinary", () => {
  test("accepts the signed bytes and rejects any change", () => {
    const { bytes, sha256, signature } = signed("a binary");
    expect(verifyBinary(bytes, sha256, signature, publicKeyPem)).toBe(true);

    const tampered = bytes.slice();
    tampered[0] = (tampered[0] ?? 0) ^ 1;
    expect(verifyBinary(tampered, sha256, signature, publicKeyPem)).toBe(false);
    // Even with a matching hash, someone else's signature fails.
    const forged = createHash("sha256").update(tampered).digest("hex");
    expect(verifyBinary(tampered, forged, signature, publicKeyPem)).toBe(false);
  });
});

describe("applyUpdate", () => {
  test("replaces both binaries, keeping the old winstond to roll back to", async () => {
    const dir = await installed();
    const { frame, fetchImpl } = release("0.1.9+b");
    const result = await applyUpdate(frame, {
      dir,
      publicKeyPem,
      versions: { winstond: "0.1.8+a", cli: "0.1.8+a" },
      fetchImpl,
    });
    expect(result).toEqual({ cliUpdated: true, winstondUpdated: true });
    expect(await readFile(join(dir, "winston"), "utf8")).toBe("new cli");
    expect(await readFile(join(dir, "winstond"), "utf8")).toBe("new winstond");
    expect(await readFile(join(dir, "winstond.previous"), "utf8")).toBe(
      "old winstond",
    );
    expect(await readFile(join(dir, "update-pending"), "utf8")).toBe("0.1.9+b");

    await confirmUpdate(dir);
    expect(await Bun.file(join(dir, "update-pending")).exists()).toBe(false);
  });

  test("only touches what differs, and skips a winstond version that already failed here", async () => {
    const dir = await installed();
    const { frame, fetchImpl } = release("0.1.9+b");
    await writeFile(join(dir, "update-failed"), "0.1.9+b");
    const result = await applyUpdate(frame, {
      dir,
      publicKeyPem,
      versions: { winstond: "0.1.8+a", cli: "0.1.9+b" },
      fetchImpl,
    });
    expect(result).toEqual({ cliUpdated: false, winstondUpdated: false });
    expect(await readFile(join(dir, "winston"), "utf8")).toBe("old cli");
    expect(await readFile(join(dir, "winstond"), "utf8")).toBe("old winstond");
  });

  test("never installs a binary that fails verification", async () => {
    const dir = await installed();
    const { frame, fetchImpl } = release("0.1.9+b");
    frame.binaries.winston.sha256 = createHash("sha256")
      .update("something else")
      .digest("hex");
    expect(
      applyUpdate(frame as never, {
        dir,
        publicKeyPem,
        versions: { winstond: "0.1.8+a", cli: "0.1.8+a" },
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(UpdateRejectedError);
    expect(await readFile(join(dir, "winston"), "utf8")).toBe("old cli");
    expect(await readFile(join(dir, "winstond"), "utf8")).toBe("old winstond");
  });
});

describe("the unit's pre-start rollback", () => {
  test("puts the previous winstond back after three failed starts, and marks the version failed", async () => {
    const script = /<<'SCRIPT'\n([\s\S]*?)\nSCRIPT\n/.exec(
      await readFile(
        new URL("../../../image/scripts/winstond.sh", import.meta.url),
        "utf8",
      ),
    )?.[1];
    if (!script) throw new Error("no pre-start script in winstond.sh");
    const dir = await installed();
    await writeFile(join(dir, "winstond.previous"), "old winstond");
    await writeFile(join(dir, "winstond"), "broken new winstond");
    await writeFile(join(dir, "update-pending"), "0.1.9+b");
    const prestart = join(dir, "prestart.sh");
    await writeFile(prestart, script, { mode: 0o755 });
    const start = () =>
      Bun.spawnSync(["sh", prestart], { env: { WINSTOND_DIR: dir } }).exitCode;

    for (let i = 0; i < 3; i++) {
      expect(start()).toBe(0);
      expect(await readFile(join(dir, "winstond"), "utf8")).toBe(
        "broken new winstond",
      );
    }
    expect(start()).toBe(0);
    expect(await readFile(join(dir, "winstond"), "utf8")).toBe("old winstond");
    expect(await readFile(join(dir, "update-failed"), "utf8")).toBe("0.1.9+b");
    expect(await Bun.file(join(dir, "update-pending")).exists()).toBe(false);
  });
});
