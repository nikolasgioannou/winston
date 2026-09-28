import { describe, expect, test } from "bun:test";
import { signPayload, verifySignedPayload } from "./signed.ts";

describe("signed tokens", () => {
  const secret = "s".repeat(32);

  test("round trips, and rejects tampering, the wrong secret and expiry", () => {
    const payload = { runId: "run_1", exp: 2_000 };
    const token = signPayload(payload, secret);
    expect(verifySignedPayload(token, secret, 1_000)).toEqual({
      runId: "run_1",
      exp: 2_000,
    });
    expect(verifySignedPayload(token, "t".repeat(32), 1_000)).toBeUndefined();
    expect(verifySignedPayload(token, secret, 3_000)).toBeUndefined();
    const [body = "", signature = ""] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ runId: "run_2", exp: 2_000 }),
    ).toString("base64url");
    expect(
      verifySignedPayload(`${forged}.${signature}`, secret, 1_000),
    ).toBeUndefined();
    expect(
      verifySignedPayload(`${body}.${signature}.x`, secret, 1_000),
    ).toBeUndefined();
    expect(verifySignedPayload("garbage", secret, 1_000)).toBeUndefined();
  });
});
