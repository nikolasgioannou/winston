import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  signSitePass,
  sitePassPublicKey,
  sitePassSigningKey,
} from "./pass-sign.ts";
import { importSitePassKey, verifySitePass, type SitePass } from "./pass.ts";

const signingKey = sitePassSigningKey(randomBytes(32).toString("hex"));
const pass: SitePass = {
  sub: "usr_1",
  site: "blog",
  nonce: "n0nce",
  exp: Date.now() + 60_000,
};

describe("site passes", () => {
  test("a pass signed with the key verifies with its public key", async () => {
    const key = await importSitePassKey(sitePassPublicKey(signingKey));
    expect(await verifySitePass(signSitePass(pass, signingKey), key)).toEqual(
      pass,
    );
  });

  test("tampered, foreign, expired and malformed passes don't", async () => {
    const key = await importSitePassKey(sitePassPublicKey(signingKey));
    const token = signSitePass(pass, signingKey);
    const [, signature] = token.split(".");
    const forged = `${btoa(JSON.stringify({ ...pass, sub: "usr_2" }))}.${String(signature)}`;
    expect(await verifySitePass(forged, key)).toBeNull();

    const other = sitePassSigningKey(randomBytes(32).toString("hex"));
    expect(await verifySitePass(signSitePass(pass, other), key)).toBeNull();

    const expired = signSitePass({ ...pass, exp: Date.now() - 1 }, signingKey);
    expect(await verifySitePass(expired, key)).toBeNull();

    expect(await verifySitePass("nonsense", key)).toBeNull();
    expect(await verifySitePass("a.b.c", key)).toBeNull();
  });

  test("any long secret makes a key, the same one each time; short ones don't", async () => {
    const generated = "aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5bC7dE9fG1hJ3";
    expect(sitePassPublicKey(sitePassSigningKey(generated))).toBe(
      sitePassPublicKey(sitePassSigningKey(generated)),
    );
    const key = await importSitePassKey(
      sitePassPublicKey(sitePassSigningKey(generated)),
    );
    expect(
      await verifySitePass(
        signSitePass(pass, sitePassSigningKey(generated)),
        key,
      ),
    ).toEqual(pass);
    expect(() => sitePassSigningKey("abcd")).toThrow(/at least 32/);
  });
});
