import { describe, expect, test } from "bun:test";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { canonicalJson } from "./json.ts";
import {
  createTokenVault,
  kmsTokenVault,
  localTokenVault,
  type KmsDataKeys,
} from "./token-vault.ts";

const key = "11".repeat(32);
const vault = localTokenVault(key);
const context = { connectionId: "acct_1" };

const fails = (promise: Promise<unknown>) =>
  promise.then(
    () => false,
    () => true,
  );

describe("localTokenVault", () => {
  test("round-trips, with a fresh IV each time", async () => {
    const token = "1//refresh-token-ünïcode";
    const a = await vault.encrypt(token, context);
    const b = await vault.encrypt(token, context);
    expect(a).not.toBe(b);
    expect(a.startsWith("local:v1:")).toBe(true);
    expect(a).not.toContain("refresh");
    expect(await vault.decrypt(a, context)).toBe(token);
  });

  test("rejects tampered bytes, a truncated tag, another context, another key or another scheme", async () => {
    const sealed = await vault.encrypt("secret", context);
    const [scheme, version, iv, body, tag] = sealed.split(":");
    const flipped = Buffer.from(body ?? "", "base64url");
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    const shortTag = Buffer.from(tag ?? "", "base64url").subarray(0, 8);

    expect(
      await fails(
        vault.decrypt(
          [scheme, version, iv, flipped.toString("base64url"), tag].join(":"),
          context,
        ),
      ),
    ).toBe(true);
    expect(
      await fails(
        vault.decrypt(
          [scheme, version, iv, body, shortTag.toString("base64url")].join(":"),
          context,
        ),
      ),
    ).toBe(true);
    expect(await fails(vault.decrypt(sealed, { connectionId: "acct_2" }))).toBe(
      true,
    );
    expect(
      await fails(localTokenVault("22".repeat(32)).decrypt(sealed, context)),
    ).toBe(true);
    expect(
      await fails(vault.decrypt(sealed.replace("local:", "kms:"), context)),
    ).toBe(true);
  });

  test("refuses a key that isn't 32 bytes of hex", () => {
    expect(() => localTokenVault("abc")).toThrow();
  });
});

/**
 * A stand-in for KMS: data keys are wrapped under a master key with the
 * encryption context bound in, so a wrong key id or context fails like it
 * does in KMS. Records calls and the plaintext keys it handed out.
 */
function fakeKms(master = randomBytes(32)) {
  const calls: string[] = [];
  const handedOut: Uint8Array[] = [];
  const kms: KmsDataKeys = {
    generate(keyId, context) {
      calls.push(`generate ${keyId}`);
      const plaintext = randomBytes(32);
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", master, iv).setAAD(
        Buffer.from(keyId + canonicalJson(context)),
      );
      const wrapped = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      handedOut.push(plaintext);
      return Promise.resolve({
        plaintext,
        encrypted: Buffer.concat([iv, wrapped, cipher.getAuthTag()]),
      });
    },
    decrypt(keyId, encrypted, context) {
      calls.push(`decrypt ${keyId}`);
      return Promise.try(() => {
        const bytes = Buffer.from(encrypted);
        const decipher = createDecipheriv(
          "aes-256-gcm",
          master,
          bytes.subarray(0, 12),
        )
          .setAAD(Buffer.from(keyId + canonicalJson(context)))
          .setAuthTag(bytes.subarray(-16));
        return Buffer.concat([
          decipher.update(bytes.subarray(12, -16)),
          decipher.final(),
        ]);
      });
    },
  };
  return { kms, calls, handedOut };
}

describe("kmsTokenVault", () => {
  const keyId = "alias/winston/tokens";

  test("round-trips with a fresh data key per encryption, and forgets the key", async () => {
    const { kms, calls, handedOut } = fakeKms();
    const vault = kmsTokenVault(kms, keyId);
    const token = "1//refresh-token-ünïcode";
    const a = await vault.encrypt(token, context);
    const b = await vault.encrypt(token, context);
    expect(a.startsWith("kms:v1:")).toBe(true);
    expect(a.split(":")).toHaveLength(6);
    expect(a.split(":")[2]).not.toBe(b.split(":")[2]);
    expect(a).not.toContain("refresh");
    expect(handedOut.every((key) => key.every((byte) => byte === 0))).toBe(
      true,
    );
    expect(await vault.decrypt(a, context)).toBe(token);
    expect(calls).toEqual([
      `generate ${keyId}`,
      `generate ${keyId}`,
      `decrypt ${keyId}`,
    ]);
  });

  test("rejects tampered bytes, another context, another KMS key or a local ciphertext", async () => {
    const { kms } = fakeKms();
    const vault = kmsTokenVault(kms, keyId);
    const sealed = await vault.encrypt("secret", context);
    const pieces = sealed.split(":");
    const flipped = Buffer.from(pieces[4] ?? "", "base64url");
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    const tampered = pieces.with(4, flipped.toString("base64url")).join(":");

    expect(await fails(vault.decrypt(tampered, context))).toBe(true);
    expect(await fails(vault.decrypt(sealed, { connectionId: "acct_2" }))).toBe(
      true,
    );
    expect(
      await fails(kmsTokenVault(kms, "other").decrypt(sealed, context)),
    ).toBe(true);
    expect(
      await fails(
        vault.decrypt(
          await localTokenVault(key).encrypt("x", context),
          context,
        ),
      ),
    ).toBe(true);
  });
});

describe("createTokenVault", () => {
  test("uses the local key when it's the one set", async () => {
    const vault = createTokenVault({ TOKEN_ENCRYPTION_KEY: key });
    expect((await vault.encrypt("x", context)).startsWith("local:v1:")).toBe(
      true,
    );
  });

  test("needs exactly one of the KMS key and the local key", () => {
    expect(() => createTokenVault({})).toThrow(/TOKEN_KMS_KEY_ID/);
    expect(() =>
      createTokenVault({ TOKEN_KMS_KEY_ID: "k", TOKEN_ENCRYPTION_KEY: key }),
    ).toThrow(/only one/);
  });
});
