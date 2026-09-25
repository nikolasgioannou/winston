import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  actionRecordSchema,
  actionRequestSchema,
  actionTaskSchema,
  type ActionTask,
} from "@winston/contracts/actions";
import { calendarMutationIntentSchema } from "@winston/contracts/calendar-mutations";
import { canonicalJson } from "@winston/contracts/json";
import { taskSchema } from "@winston/contracts/tasks";
import { readCalendarMutationArguments } from "../google/calendar-mutation-plan";
import type { DatabaseTransaction } from "./owners";
import { actionRepository } from "./actions";
import { connectionRepository } from "./connections";
import { connectionTargetRepository } from "./connection-targets";

export function calendarActionRepository(transaction: DatabaseTransaction, ownerId: string) {
  async function context(inputTask: ActionTask, key: string, inputIntent: unknown) {
    const worker = actionTaskSchema.parse(inputTask);
    const intent = calendarMutationIntentSchema.parse(inputIntent);
    if (!key.length || key.length > 100) throw new Error("Invalid Calendar action key.");
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
      throw new Error("Calendar action worker lease is stale or expired.");
    const requestKey = `calendar:${worker.id}:${String(row.intentRevision)}:${createHash("sha256").update(key).digest("hex")}`;
    const previous = await transaction.execute<{ document: unknown }>(sql`
      SELECT document FROM winston.actions WHERE owner_id = ${ownerId}::uuid AND request_key = ${requestKey}
    `);
    const stored = previous.rows[0];
    const action = stored ? actionRecordSchema.parse(stored.document) : null;
    if (action) {
      const payload = readCalendarMutationArguments(action.request.arguments);
      if (
        canonicalJson(payload.intent) !== canonicalJson(intent) ||
        action.operationId !== payload.plan.operationId
      )
        throw new Error("Calendar action key conflicts with its original intent.");
    }
    return { worker, intent, requestKey, action };
  }

  return {
    // Look up before fetching provider data: approval waits retain the original plan and identity.
    async find(inputTask: ActionTask, key: string, inputIntent: unknown) {
      return (await context(inputTask, key, inputIntent)).action;
    },
    // A trusted adapter resolves the target and reads any existing event before preparing a plan.
    async prepare(inputTask: ActionTask, key: string, inputIntent: unknown, inputPlan: unknown) {
      const { worker, intent, requestKey, action } = await context(inputTask, key, inputIntent);
      if (action) return action;
      const payload = readCalendarMutationArguments({ intent, plan: inputPlan });
      const plan = payload.plan;
      const target = plan.request.target;
      if (target.task?.id !== worker.id || target.task.revision !== worker.revision)
        throw new Error("Calendar plan does not match its worker task.");
      const connection = await connectionRepository(transaction, ownerId).find(target.connectionId);
      const preferences = await connectionTargetRepository(transaction, ownerId).preferences();
      if (
        connection?.service !== "calendar" ||
        connection.revision !== target.connectionRevision ||
        preferences.revision !== target.preferencesRevision
      )
        throw new Error("Calendar plan target changed before preparation.");
      return actionRepository(transaction, ownerId).prepare(
        {
          key: requestKey,
          task: worker,
          bindingKey: "calendar.write",
          authorization: {
            target: { kind: "connection", id: target.connectionId, resource: target.calendarId },
            operation: "calendar.write",
          },
          arguments: actionRequestSchema.shape.arguments.parse(JSON.parse(canonicalJson(payload))),
        },
        { operationId: plan.operationId },
      );
    },
  };
}
