import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createCredentialCipher, readCredentialCipher } from "@winston/adapters/credentials";

test("credential encryption binds owner, identity and revision and supports retained rotation keys", () => {
  const oldKey = Buffer.alloc(32, 1).toString("base64");
  const newKey = Buffer.alloc(32, 2).toString("base64");
  const old = createCredentialCipher("old", { old: oldKey });
  const next = createCredentialCipher("next", { old: oldKey, next: newKey });
  const binding = {
    ownerId: randomUUID(),
    id: randomUUID(),
    provider: "google" as const,
    revision: 0,
  };
  const grant = {
    accessToken: "synthetic-access-canary",
    refreshToken: "synthetic-refresh-canary",
    expiresAt: new Date().toISOString(),
    scopes: ["scope"],
  };
  const encrypted = old.encrypt(binding, grant);
  assert.ok(!JSON.stringify(encrypted).includes("canary"));
  assert.notEqual(old.encrypt(binding, grant).nonce, encrypted.nonce);
  assert.deepEqual(next.decrypt(binding, encrypted), grant);
  assert.throws(
    () => old.decrypt({ ...binding, ownerId: randomUUID() }, encrypted),
    /could not be authenticated/,
  );
  assert.throws(
    () => old.decrypt({ ...binding, id: randomUUID() }, encrypted),
    /could not be authenticated/,
  );
  assert.throws(
    () => old.decrypt({ ...binding, revision: 1 }, encrypted),
    /could not be authenticated/,
  );
  assert.throws(
    () => old.decrypt(binding, { ...encrypted, tag: Buffer.alloc(16).toString("base64") }),
    /could not be authenticated/,
  );
  const rotated = next.encrypt({ ...binding, revision: 1 }, grant);
  const retired = createCredentialCipher("next", { next: newKey });
  assert.deepEqual(retired.decrypt({ ...binding, revision: 1 }, rotated), grant);
  assert.throws(() => retired.decrypt(binding, encrypted), /could not be authenticated/);
  assert.throws(
    () =>
      readCredentialCipher({
        CREDENTIAL_ACTIVE_KEY: "canary",
        CREDENTIAL_KEYS: "synthetic-secret-canary",
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes("canary"));
      return true;
    },
  );
});
