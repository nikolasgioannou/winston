import { describe, expect, test } from "bun:test";
import {
  inRollback,
  insertConnection,
  insertUser,
  testDb,
} from "@winston/db/testing";
import { capabilityScopes } from "@winston/domain/connections";
import { setupApi } from "./testing.ts";

const db = await testDb();
const rampAccount = {
  domain: "ramp" as const,
  provider: "ramp" as const,
  externalEmail: "ada@acme.com",
  scopes: [...capabilityScopes.ramp.read],
};

type Json = Record<string, unknown>;

describe("ramp routes", () => {
  test("transactions are listed with txn_ ids, dates in the user's zone, and the same id every time", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx, { timezone: "America/New_York" });
      await insertConnection(tx, user.id, rampAccount);
      const { as, ramp } = setupApi(tx);
      const call = as(user.id);
      const first = (await (
        await call(
          "/v1/ramp/transactions?scope=awaiting_me&text=uber&since=2026-09-01T02:00Z",
        )
      ).json()) as {
        items: { id: string; merchant: string }[];
        cursor: string;
      };
      const second = (await (await call("/v1/ramp/transactions")).json()) as {
        items: { id: string }[];
      };
      expect(first.items[0]?.id).toStartWith("txn_");
      expect(first.items[0]).not.toHaveProperty("providerId");
      expect(second.items[0]?.id).toBe(first.items[0]?.id ?? "");
      expect(first.cursor).toBe("c2");
      // 02:00 UTC on Sept 1 is still Aug 31 in New York.
      expect(ramp.calls[0]?.args[0]).toMatchObject({
        scope: "awaiting_me",
        text: "uber",
        since: "2026-08-31",
      });

      // An id from the list gets that transaction.
      const got = (await (
        await call(`/v1/ramp/transactions/${first.items[0]?.id ?? ""}`)
      ).json()) as { transaction: { id: string; amount: string } };
      expect(got.transaction).toMatchObject({
        id: first.items[0]?.id ?? "",
        amount: "42.50",
      });
      expect(ramp.calls.at(-1)).toEqual({
        method: "transaction",
        args: ["tx-1"],
      });
    });
  });

  test("what's waiting on the user names its objects by CLI id", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      await insertConnection(tx, user.id, rampAccount);
      const body = (await (
        await setupApi(tx).as(user.id)("/v1/ramp/approvals")
      ).json()) as {
        sections: {
          name: string;
          tasks: { summary: string; ids: string[] }[];
        }[];
      };
      expect(body.sections[0]?.name).toBe("Transaction approvals");
      expect(body.sections[0]?.tasks[0]?.summary).toBe("Uber · $42.50");
      expect(body.sections[0]?.tasks[0]?.ids[0]).toStartWith("txn_");
    });
  });

  test("no Ramp account, reading off, an id of another kind, and short search text", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const call = setupApi(tx).as(user.id);
      expect((await call("/v1/ramp/bills")).status).toBe(404);

      await insertConnection(tx, user.id, {
        ...rampAccount,
        capabilities: { read: false },
      });
      const off = await call("/v1/ramp/bills");
      expect(off.status).toBe(403);
      expect(((await off.json()) as Json).error).toMatchObject({
        code: "permission_disabled",
      });

      expect(
        (await call("/v1/ramp/bills/txn_01k5aaaaaaaaaaaaaaaaaaaaaa")).status,
      ).toBe(404);
      expect((await call("/v1/ramp/transactions?text=ub")).status).toBe(400);
    });
  });

  test("an expired grant is auth_expired, with Ramp's reconnect link", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const connection = await insertConnection(tx, user.id, {
        ...rampAccount,
        status: "expired",
      });
      const response = await setupApi(tx).as(user.id)("/v1/ramp/approvals");
      const error = ((await response.json()) as { error: Json }).error;
      expect(error.code).toBe("auth_expired");
      expect(error.hint).toContain(
        `/auth/ramp/connect?reconnect=${connection.id}`,
      );
    });
  });

  test("a scope Ramp didn't grant makes reading unavailable, with the reconnect link", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const connection = await insertConnection(tx, user.id, {
        ...rampAccount,
        scopes: ["users:read"],
      });
      const response = await setupApi(tx).as(user.id)("/v1/ramp/approvals");
      expect(response.status).toBe(403);
      const error = ((await response.json()) as { error: Json }).error;
      expect(error.message).toContain("on Ramp's screen");
      expect(error.hint).toContain(
        `/auth/ramp/connect?reconnect=${connection.id}`,
      );
    });
  });
});
