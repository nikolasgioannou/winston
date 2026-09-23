import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  actionRecordSchema,
  actionRequestSchema,
  actionTaskSchema,
  type ActionTask,
} from "@winston/contracts/actions";
import {
  cliReadRequestSchema,
  cliResultSchema,
  type CliReadRequest,
  type CliResult,
} from "@winston/contracts/cli";
import { canonicalJson } from "@winston/contracts/json";
import { taskSchema } from "@winston/contracts/tasks";
import type { DatabaseTransaction } from "./owners";
import { actionRepository } from "./actions";
import { connectionTargetKey } from "./connection-target-key";

export function connectedReadRepository(transaction: DatabaseTransaction, ownerId: string) {
  const actions = actionRepository(transaction, ownerId);
  return {
    async prepare(inputTask: ActionTask, key: string, input: CliReadRequest) {
      const worker = actionTaskSchema.parse(inputTask);
      const request = cliReadRequestSchema.parse(input);
      if (!key.length || key.length > 100 || request.command === "calendars.list")
        throw new Error("Invalid approval read request.");
      await transaction.execute(
        sql`SELECT id FROM winston.owners WHERE id = ${ownerId}::uuid FOR UPDATE`,
      );
      const rows = await transaction.execute<{
        document: unknown;
        intentRevision: number;
        live: boolean;
      }>(sql`
        SELECT document, intent_revision AS "intentRevision", leased_until > clock_timestamp() AS live
        FROM winston.tasks WHERE owner_id = ${ownerId}::uuid AND id = ${worker.id}::uuid FOR UPDATE
      `);
      const row = rows.rows[0];
      const task = row ? taskSchema.parse(row.document) : null;
      if (
        !row?.live ||
        task?.state !== "running" ||
        task.revision !== worker.revision ||
        task.generation !== worker.generation
      )
        throw new Error("Worker lease is stale or expired.");
      const requestKey = `read:${worker.id}:${String(row.intentRevision)}:${createHash("sha256").update(key).digest("hex")}`;
      const previous = await transaction.execute<{ document: unknown; result: unknown }>(sql`
        SELECT a.document, r.result FROM winston.actions a
        LEFT JOIN winston.connected_read_results r ON r.owner_id = a.owner_id AND r.action_id = a.id
        WHERE a.owner_id = ${ownerId}::uuid AND a.request_key = ${requestKey}
      `);
      const stored = previous.rows[0];
      if (stored) {
        const action = actionRecordSchema.parse(stored.document);
        if (canonicalJson(action.request.arguments) !== canonicalJson(request))
          throw new Error("Read key conflicts with its original request.");
        return {
          action,
          result: stored.result === null ? null : cliResultSchema.parse(stored.result),
        };
      }
      const operation = request.command.startsWith("gmail.") ? "gmail.read" : "calendar.read";
      const calendarId = "calendarId" in request ? request.calendarId : null;
      const action = await actions.prepare({
        key: requestKey,
        task: worker,
        bindingKey: connectionTargetKey({
          operation,
          explicit: { connectionId: request.accountId, calendarId },
        }),
        authorization: {
          target: { kind: "connection", id: request.accountId, resource: calendarId },
          operation,
        },
        arguments: actionRequestSchema.shape.arguments.parse(JSON.parse(JSON.stringify(request))),
      });
      return { action, result: null };
    },
    async complete(id: string, token: string, input: CliResult) {
      const result = cliResultSchema.parse(input);
      if (
        !["ok", "unavailable", "unknown"].includes(result.status) ||
        Buffer.byteLength(JSON.stringify(result)) > 900_000
      )
        throw new Error("Invalid connected read receipt.");
      const action = await actions.find(id);
      if (
        !action ||
        action.request.authorization.target.kind !== "connection" ||
        !["gmail.read", "calendar.read"].includes(action.request.authorization.operation)
      )
        return null;
      const previous = await transaction.execute<{ result: unknown }>(sql`
        SELECT result FROM winston.connected_read_results WHERE owner_id = ${ownerId}::uuid AND action_id = ${id}::uuid
      `);
      if (
        previous.rows[0] &&
        canonicalJson(cliResultSchema.parse(previous.rows[0].result)) !== canonicalJson(result)
      )
        return null;
      const recorded = await actions.report(id, token, {
        state:
          result.status === "ok" ? "succeeded" : result.status === "unknown" ? "unknown" : "failed",
        detail:
          result.status === "ok"
            ? "Connected read completed."
            : "Connected read did not return a usable result.",
        providerReference: null,
      });
      if (!recorded) return null;
      await transaction.execute(sql`
        INSERT INTO winston.connected_read_results (owner_id, action_id, result)
        VALUES (${ownerId}::uuid, ${id}::uuid, ${JSON.stringify(result)}::jsonb)
        ON CONFLICT (owner_id, action_id) DO NOTHING
      `);
      return result;
    },
  };
}
