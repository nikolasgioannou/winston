import { describe, expect, test } from "bun:test";
import { localTokenVault } from "./token-vault.ts";

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
