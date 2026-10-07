import { describe, expect, test } from "bun:test";
import type { DbOrTx } from "@winston/db/client";
import { refFor } from "@winston/db/external-refs";
import { auditLog, connections } from "@winston/db/schema";
import {
  inRollback,
  insertConnection,
  insertRun,
  insertUser,
  testDb,
} from "@winston/db/testing";
import {
  capabilityScopes,
  rampConnectScopes,
} from "@winston/domain/connections";
import { eq } from "drizzle-orm";
import { setupApi } from "./testing.ts";

const db = await testDb();

/** A Ramp account with these capabilities on, and an id for one of its transactions. */
async function rampWith(tx: DbOrTx, capabilities: Record<string, boolean>) {
  const user = await insertUser(tx);
  const connection = await insertConnection(tx, user.id, {
    domain: "ramp",
    provider: "ramp",
    externalEmail: "ada@acme.com",
    scopes: [...rampConnectScopes],
    capabilities: { read: true, ...capabilities },
  });
  const run = await insertRun(tx, user.id);
  const txn = await refFor(
    tx,
    user.id,
    connection.id,
    "rampTransaction",
    "tx-1",
  );
  const rmb = await refFor(
    tx,
    user.id,
    connection.id,
    "rampReimbursement",
    "rb-1",
  );
  const req = await refFor(tx, user.id, connection.id, "rampRequest", "rq-1");
  return { user, run, connection, txn, rmb, req };
}

type Json = Record<string, unknown>;
const post = (body: unknown) => ({ method: "POST", body });

describe("ramp write routes", () => {
  test("approving is refused while approve is off, and changes nothing", async () => {
    await inRollback(db, async (tx) => {
      const { user, run, txn } = await rampWith(tx, { approve: false });
      const { as, ramp } = setupApi(tx);
      const response = await as(user.id, run.id)(
        `/v1/ramp/transactions/${txn}/approve`,
        post({}),
      );
      expect(response.status).toBe(403);
      expect(((await response.json()) as { error: Json }).error.code).toBe(
        "permission_disabled",
      );
      expect(ramp.calls.filter((c) => c.method === "decide")).toEqual([]);
    });
  });

  test("a dry run shows what would be approved and calls nothing; the real one is audited", async () => {
    await inRollback(db, async (tx) => {
      const { user, run, txn } = await rampWith(tx, { approve: true });
      const { as, ramp } = setupApi(tx);
      const call = as(user.id, run.id);
      const dry = (await (
        await call(
          `/v1/ramp/transactions/${txn}/approve`,
          post({ dryRun: true }),
        )
      ).json()) as Json;
      expect(dry).toMatchObject({
        dryRun: true,
        decision: "approve",
        about: { what: "Uber 42.50", who: "Ada Lovelace" },
      });
      expect(ramp.calls.filter((c) => c.method === "decide")).toEqual([]);

      await call(`/v1/ramp/transactions/${txn}/approve`, post({}));
      expect(ramp.calls.filter((c) => c.method === "decide")).toEqual([
        {
          method: "decide",
          args: ["rampTransaction", "tx-1", "approve", undefined],
        },
      ]);
      const [row] = await tx
        .select()
        .from(auditLog)
        .where(eq(auditLog.userId, user.id));
      expect(row).toMatchObject({
        action: "ramp.approve",
        outcome: "ok",
        targetRef: txn,
        summary: "Approved Uber 42.50 from Ada Lovelace",
      });
    });
  });

  test("rejecting a transaction needs a note; a reimbursement or request doesn't", async () => {
    await inRollback(db, async (tx) => {
      const { user, run, txn, rmb, req } = await rampWith(tx, {
        approve: true,
      });
      const { as, ramp } = setupApi(tx);
      const call = as(user.id, run.id);
      expect(
        (await call(`/v1/ramp/transactions/${txn}/reject`, post({}))).status,
      ).toBe(400);
      expect(
        (await call(`/v1/ramp/reimbursements/${rmb}/reject`, post({}))).status,
      ).toBe(200);
      expect(
        (
          await call(
            `/v1/ramp/requests/${req}/reject`,
            post({ note: "Over budget" }),
          )
        ).status,
      ).toBe(200);
      expect(
        ramp.calls.filter((c) => c.method === "decide").map((c) => c.args),
      ).toEqual([
        ["rampReimbursement", "rb-1", "reject", undefined],
        ["rampRequest", "rq-1", "reject", "Over budget"],
      ]);
    });
  });

  test("a memo needs edit, submitting needs submit, and an id of another kind is not found", async () => {
    await inRollback(db, async (tx) => {
      const { user, run, txn, rmb } = await rampWith(tx, { edit: true });
      const { as, ramp } = setupApi(tx);
      const call = as(user.id, run.id);
      expect(
        (
          await call(
            `/v1/ramp/transactions/${txn}/update`,
            post({ memo: "Client dinner" }),
          )
        ).status,
      ).toBe(200);
      expect(ramp.calls.at(-1)).toEqual({
        method: "setMemo",
        args: ["rampTransaction", "tx-1", "Client dinner"],
      });
      expect(
        (await call(`/v1/ramp/reimbursements/${rmb}/submit`, post({}))).status,
      ).toBe(403);
      expect(
        (
          await call(
            `/v1/ramp/reimbursements/${txn}/update`,
            post({ memo: "x" }),
          )
        ).status,
      ).toBe(404);
      expect(
        (await call(`/v1/ramp/transactions/${txn}/update`, post({}))).status,
      ).toBe(400);
    });
  });

  test("a write whose scope Ramp didn't grant is refused before Ramp is asked", async () => {
    await inRollback(db, async (tx) => {
      const { user, run, txn } = await rampWith(tx, { approve: true });
      await tx
        .update(connections)
        .set({ scopes: [...capabilityScopes.ramp.read] })
        .where(eq(connections.userId, user.id));
      const { as, ramp } = setupApi(tx);
      const response = await as(user.id, run.id)(
        `/v1/ramp/transactions/${txn}/approve`,
        post({}),
      );
      expect(response.status).toBe(403);
      expect(ramp.calls).toEqual([]);
    });
  });
});
