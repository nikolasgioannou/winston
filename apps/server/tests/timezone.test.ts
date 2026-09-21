import assert from "node:assert/strict";
import { test } from "bun:test";
import type { OwnerTransaction } from "@winston/adapters/database";
import { createApi } from "../src/http/app";
import { createOwnerRouter } from "../src/http/owner";

test("timezone routes reject unauthenticated calls and malformed updates before persistence", async () => {
  let updates = 0;
  const profile = { timezone: "UTC", revision: 0, observedAt: null, source: "default" as const };
  const scope: Pick<OwnerTransaction, "ownerId" | "owners"> = {
    ownerId: "fixture",
    owners: {
      find: () => Promise.resolve(undefined),
      ensure: () => {
        throw new Error("Unexpected owner creation.");
      },
      timezone: () => Promise.resolve(profile),
      updateTimezone: () => {
        updates += 1;

        return Promise.resolve({ profile, conflict: true });
      },
    },
  };
  const router = createOwnerRouter({
    transaction<Result>(
      ownerId: string,
      work: (scope: Pick<OwnerTransaction, "ownerId" | "owners">) => Promise<Result>,
    ) {
      assert.equal(ownerId, "fixture");

      return work(scope);
    },
  });
  let authenticated = false;
  const { app } = createApi({
    ownerOrigin: "http://127.0.0.1:5173",
    groups: {
      owner: {
        router,
        authenticate: () =>
          Promise.resolve(authenticated ? { kind: "owner", ownerId: "fixture" } : null),
      },
    },
  });
  assert.equal((await app.request("/api/owner/timezone")).status, 401);
  authenticated = true;
  assert.deepEqual(await (await app.request("/api/owner/timezone")).json(), profile);
  const headers = { Origin: "http://127.0.0.1:5173", "Content-Type": "application/json" };
  assert.equal(
    (
      await app.request("/api/owner/timezone", {
        method: "PUT",
        headers,
        body: '{"timezone":"UTC","revision":"0"}',
      })
    ).status,
    400,
  );
  assert.equal(updates, 0);
  assert.equal(
    (
      await app.request("/api/owner/timezone", {
        method: "PUT",
        headers,
        body: '{"timezone":"UTC","revision":0}',
      })
    ).status,
    409,
  );
  assert.equal(updates, 1);
});
