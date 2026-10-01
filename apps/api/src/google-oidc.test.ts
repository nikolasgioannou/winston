import { describe, expect, test } from "bun:test";
import { verifyPushToken } from "./google-oidc.ts";
import { pushToken, testJwks, testPush } from "./testing.ts";

const check = async (token: string | undefined) =>
  verifyPushToken(
    token === undefined ? undefined : `Bearer ${token}`,
    testPush,
    testJwks,
  );

describe("Pub/Sub push tokens", () => {
  test("a token from Google for our audience and service account is accepted, either issuer form", async () => {
    expect(await check(await pushToken())).toEqual({ ok: true });
    expect(
      await check(await pushToken({}, { issuer: "accounts.google.com" })),
    ).toEqual({ ok: true });
  });

  test("wrong audience, expired, wrong issuer, wrong account, unverified email or none are refused", async () => {
    const refused = async (token: string | undefined) =>
      (await check(token)).ok;
    expect(
      await refused(await pushToken({}, { audience: "https://evil.example" })),
    ).toBe(false);
    expect(await refused(await pushToken({}, { expiresIn: "-1m" }))).toBe(
      false,
    );
    expect(
      await refused(await pushToken({}, { issuer: "https://evil.example" })),
    ).toBe(false);
    expect(
      await refused(await pushToken({ email: "someone@example.com" })),
    ).toBe(false);
    expect(await refused(await pushToken({ email_verified: false }))).toBe(
      false,
    );
    expect(await refused(undefined)).toBe(false);
    expect(await refused("not-a-jwt")).toBe(false);
  });
});
