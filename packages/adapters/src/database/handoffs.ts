import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  handoffEvidenceSchema,
  handoffRequestSchema,
  handoffSchema,
  type Handoff,
  type HandoffEvidence,
  type HandoffRequest,
} from "@winston/contracts/handoffs";
import { taskSchema } from "@winston/contracts/tasks";
import { canonicalJson } from "@winston/contracts/json";
import { googleScopes } from "@winston/contracts/connections";
import type { DatabaseTransaction } from "./owners";
import { taskRepository } from "./tasks";
import { connectionRepository } from "./connections";

export function handoffRepository(transaction: DatabaseTransaction, ownerId: string) {
  async function lock() {
    await transaction.execute(
      sql`SELECT id FROM winston.owners WHERE id = ${ownerId}::uuid FOR UPDATE`,
    );
  }
  async function current(taskId: string) {
    const rows = await transaction.execute<{
      document: unknown;
      intentRevision: number;
      live: boolean;
    }>(sql`
      SELECT document, intent_revision AS "intentRevision", COALESCE(leased_until > clock_timestamp(), false) AS live
      FROM winston.tasks WHERE owner_id = ${ownerId}::uuid AND id = ${taskId}::uuid
    `);
    const row = rows.rows[0];
    return row ? { ...row, task: taskSchema.parse(row.document) } : null;
  }
  async function save(handoff: Handoff) {
    await transaction.execute(sql`
      UPDATE winston.handoffs SET document = ${JSON.stringify(handoff)}::jsonb, expires_at = ${handoff.expiresAt}::timestamptz
      WHERE owner_id = ${ownerId}::uuid AND id = ${handoff.id}::uuid
    `);
    return handoff;
  }
  async function find(inputId: string) {
    const id = handoffSchema.shape.id.parse(inputId);
    const rows = await transaction.execute<{ document: unknown; valid: boolean }>(sql`
      SELECT document, expires_at > clock_timestamp() AS valid FROM winston.handoffs
      WHERE owner_id = ${ownerId}::uuid AND id = ${id}::uuid
    `);
    const row = rows.rows[0];
    if (!row) return null;
    const handoff = handoffSchema.parse(row.document);
    if (!["pending", "expired"].includes(handoff.state)) return handoff;
    const state = await current(handoff.taskId);
    if (
      !state ||
      state.intentRevision !== handoff.intentRevision ||
      state.task.revision !== handoff.taskRevision ||
      state.task.state !== "waiting" ||
      state.task.blocker?.referenceId !== handoff.id ||
      state.task.blocker.kind !== handoff.target.kind
    )
      return { ...handoff, state: "invalidated" as const };
    return row.valid ? handoff : { ...handoff, state: "expired" as const };
  }
  return {
    find,
    async prepare(input: HandoffRequest) {
      const request = handoffRequestSchema.parse(input);
      await lock();
      const state = await current(request.task.id);
      if (!state) throw new Error("Task unavailable.");
      const hash = createHash("sha256")
        .update(
          canonicalJson({
            taskId: request.task.id,
            target: request.target,
            detail: request.detail,
          }),
        )
        .digest("hex");
      const previous = await transaction.execute<{ id: string; hash: string }>(sql`
        SELECT id, request_hash AS hash FROM winston.handoffs WHERE owner_id = ${ownerId}::uuid AND request_key = ${request.key}
      `);
      if (previous.rows[0]) {
        const existing = await find(previous.rows[0].id);
        if (
          !existing ||
          previous.rows[0].hash !== hash ||
          existing.intentRevision !== state.intentRevision
        )
          throw new Error("Handoff key conflicts with its original request.");
        return existing;
      }
      if (
        !state.live ||
        state.task.state !== "running" ||
        state.task.revision !== request.task.revision ||
        state.task.generation !== request.task.generation
      )
        throw new Error("Worker lease is stale or expired.");
      if (request.target.kind === "connection" && request.target.connectionId) {
        const connection = await connectionRepository(transaction, ownerId).find(
          request.target.connectionId,
        );
        if (!connection || connection.service !== request.target.service)
          throw new Error("Connection unavailable.");
      }
      const id = randomUUID();
      const waiting = await taskRepository(transaction, ownerId).finishStep(
        request.task.id,
        request.task.revision,
        request.task.generation,
        {
          state: "waiting",
          blocker: { kind: request.target.kind, referenceId: id, detail: request.detail },
        },
      );
      const handoff = handoffSchema.parse({
        id,
        taskId: waiting.id,
        taskRevision: waiting.revision,
        intentRevision: state.intentRevision,
        target: request.target,
        detail: request.detail,
        state: "pending",
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        resolutionId: null,
      });
      await transaction.execute(sql`
        INSERT INTO winston.handoffs (owner_id, id, task_id, request_key, request_hash, document, expires_at)
        VALUES (${ownerId}::uuid, ${id}::uuid, ${waiting.id}::uuid, ${request.key}, ${hash}, ${JSON.stringify(handoff)}::jsonb, ${handoff.expiresAt}::timestamptz)
      `);
      return handoff;
    },
    // Trusted OAuth/browser adapters only. Browser evidence must follow verified
    // session ownership and exclusive-control release, never a client assertion.
    async completeVerified(id: string, input: HandoffEvidence) {
      const evidence = handoffEvidenceSchema.parse(input);
      await lock();
      const handoff = await find(id);
      if (!handoff) return null;
      if (handoff.state !== "pending") return { handoff, resumed: false };
      let resolutionId: string;
      if (handoff.target.kind === "connection" && evidence.kind === "connection") {
        const connection = await connectionRepository(transaction, ownerId).find(
          evidence.connectionId,
        );
        if (
          !connection ||
          connection.service !== handoff.target.service ||
          connection.status !== "connected" ||
          (handoff.target.connectionId && handoff.target.connectionId !== connection.id) ||
          !googleScopes[connection.service].every((scope) => connection.scopes.includes(scope))
        )
          return { handoff, resumed: false };
        resolutionId = connection.id;
      } else if (
        handoff.target.kind === "browser" &&
        evidence.kind === "browser" &&
        handoff.target.sessionId === evidence.sessionId
      ) {
        resolutionId = evidence.sessionId;
      } else return { handoff, resumed: false };
      await taskRepository(transaction, ownerId).resume(
        handoff.taskId,
        handoff.taskRevision,
        handoff.id,
      );
      return {
        handoff: await save({ ...handoff, state: "completed", resolutionId }),
        resumed: true,
      };
    },
    // Explicit authenticated owner abandonment cancels only the matching parked task.
    async abandon(id: string) {
      await lock();
      const handoff = await find(id);
      if (!handoff || !["pending", "expired"].includes(handoff.state)) return handoff;
      await taskRepository(transaction, ownerId).cancel(handoff.taskId, handoff.taskRevision);
      return save({ ...handoff, state: "abandoned" });
    },
    // Refreshing an expired locator grants no execution or provider permission.
    async renew(id: string) {
      await lock();
      const handoff = await find(id);
      if (handoff?.state !== "expired") return handoff;
      return save({
        ...handoff,
        state: "pending",
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      });
    },
  };
}
