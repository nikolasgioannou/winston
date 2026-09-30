import { describe, expect, test } from "bun:test";
import { inboundItems, users } from "@winston/db/schema";
import { inRollback, insertUser, testDb } from "@winston/db/testing";
import { mintRunToken } from "@winston/domain/run-token";
import { eq } from "drizzle-orm";
import { createVmApi } from "./index.ts";

const db = await testDb();
const secret = "vm-api-test-secret-0123456789abcdef";

function call(
  app: ReturnType<typeof createVmApi>,
  vmUserId: string,
  token: string | undefined,
  init: { method?: string; path?: string; body?: unknown } = {},
) {
  return app.request(
    init.path ?? "/v1/me",
    {
      method: init.method ?? "GET",
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "Content-Type": "application/json",
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    },
    { vmUserId },
  );
}

describe("VM-facing API", () => {
  test("a valid token over the user's own VM gets their profile", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx, { timezone: "America/New_York" });
      const app = createVmApi({ db: tx, runTokenSecret: secret });
      const token = mintRunToken(
        secret,
        { runId: "run_1", userId: user.id, kind: "front" },
        60_000,
      );
      const response = await call(app, user.id, token);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        id: user.id,
        email: user.email,
        timezone: "America/New_York",
      });
    });
  });

  test("a valid token carried over another user's VM is rejected", async () => {
    await inRollback(db, async (tx) => {
      const [alice, bob] = [await insertUser(tx), await insertUser(tx)];
      const app = createVmApi({ db: tx, runTokenSecret: secret });
      const alicesToken = mintRunToken(
        secret,
        { runId: "run_1", userId: alice.id, kind: "front" },
        60_000,
      );
      const response = await call(app, bob.id, alicesToken);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        error: { code: "unauthorized" },
      });
    });
  });

  test("expired, tampered and missing tokens are rejected, with the standard error shape", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const app = createVmApi({ db: tx, runTokenSecret: secret });
      const expired = mintRunToken(
        secret,
        { runId: "r", userId: user.id, kind: "front" },
        1_000,
        Date.now() - 10_000,
      );
      const forged = mintRunToken(
        "some-other-secret-0123456789abcdef",
        { runId: "r", userId: user.id, kind: "front" },
        60_000,
      );
      for (const token of [expired, forged, undefined]) {
        const response = await call(app, user.id, token);
        expect(response.status).toBe(401);
        const body = (await response.json()) as {
          error: Record<string, unknown>;
        };
        expect(Object.keys(body.error).sort()).toEqual([
          "code",
          "hint",
          "message",
        ]);
      }
    });
  });

  test("PATCH /v1/me updates the time zone through the shared path, and refuses one that isn't IANA", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx, { timezone: "America/New_York" });
      const app = createVmApi({ db: tx, runTokenSecret: secret });
      const token = mintRunToken(
        secret,
        { runId: "r", userId: user.id, kind: "front" },
        60_000,
      );
      const ok = await call(app, user.id, token, {
        method: "PATCH",
        body: { timezone: "Europe/London" },
      });
      expect(await ok.json()).toMatchObject({ timezone: "Europe/London" });
      const [row] = await tx.select().from(users).where(eq(users.id, user.id));
      expect(row?.timezone).toBe("Europe/London");
      // Winston hears of it the same way as a change on the site.
      const items = await tx
        .select({ type: inboundItems.type, payload: inboundItems.payload })
        .from(inboundItems)
        .where(eq(inboundItems.userId, user.id));
      expect(items).toEqual([
        {
          type: "system.settings.changed",
          payload: {
            field: "timezone",
            old: "America/New_York",
            new: "Europe/London",
            source: "winston",
          },
        },
      ]);

      const bad = await call(app, user.id, token, {
        method: "PATCH",
        body: { timezone: "Mars/Olympus" },
      });
      expect(bad.status).toBe(400);
      expect(await bad.json()).toMatchObject({
        error: { code: "invalid_request" },
      });
    });
  });

  test("unknown routes get the standard not_found error", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const app = createVmApi({ db: tx, runTokenSecret: secret });
      const token = mintRunToken(
        secret,
        { runId: "r", userId: user.id, kind: "front" },
        60_000,
      );
      const response = await call(app, user.id, token, { path: "/v1/nope" });
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({
        error: { code: "not_found", hint: expect.any(String) as string },
      });
    });
  });
});
