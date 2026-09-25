import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  actionRecordSchema,
  actionRequestSchema,
  actionTaskSchema,
  type ActionTask,
} from "@winston/contracts/actions";
import { gmailLabelMutationIntentSchema } from "@winston/contracts/gmail-label-mutations";
import { canonicalJson } from "@winston/contracts/json";
import { taskSchema } from "@winston/contracts/tasks";
import {
  readGmailLabelMutationPlan,
  gmailLabelMutationIntent,
} from "../google/gmail-label-mutation-plan";
import type { DatabaseTransaction } from "./owners";
import { actionRepository } from "./actions";
import { connectionTargetKey } from "./connection-target-key";
import { assertGmailMutationResolved } from "./gmail-mutation-blocking";
import { gmailLabelActionReferencesCurrent } from "./gmail-label-action-references";

export function gmailLabelActionRepository(transaction: DatabaseTransaction, ownerId: string) {
  async function context(inputTask: ActionTask, key: string, inputIntent: unknown) {
    const worker = actionTaskSchema.parse(inputTask);
    const intent = gmailLabelMutationIntentSchema.parse(inputIntent);
    if (!key.length || key.length > 100) throw new Error("Invalid Gmail label action key.");
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
      throw new Error("Gmail label worker lease is stale or expired.");
    const requestKey = `gmail-label:${worker.id}:${String(row.intentRevision)}:${createHash("sha256").update(key).digest("hex")}`;
    const previous = await transaction.execute<{ document: unknown }>(sql`
      SELECT document FROM winston.actions WHERE owner_id = ${ownerId}::uuid AND request_key = ${requestKey}
    `);
    const stored = previous.rows[0];
    const action = stored ? actionRecordSchema.parse(stored.document) : null;
    if (!action) await assertGmailMutationResolved(transaction, ownerId, worker.id);
    if (action) {
      const plan = readGmailLabelMutationPlan(action.request.arguments);
      if (
        canonicalJson(gmailLabelMutationIntent(plan)) !== canonicalJson(intent) ||
        action.operationId !== plan.operationId
      )
        throw new Error("Gmail label action key conflicts with its original intent.");
    }
    return { worker, intent, requestKey, action };
  }
  return {
    referencesCurrent(inputPlan: unknown) {
      return gmailLabelActionReferencesCurrent(
        transaction,
        ownerId,
        readGmailLabelMutationPlan(inputPlan),
      );
    },
    async find(inputTask: ActionTask, key: string, inputIntent: unknown) {
      return (await context(inputTask, key, inputIntent)).action;
    },
    async prepare(inputTask: ActionTask, key: string, inputIntent: unknown, inputPlan: unknown) {
      const { worker, intent, requestKey, action } = await context(inputTask, key, inputIntent);
      if (action) return action;
      const plan = readGmailLabelMutationPlan(inputPlan);
      if (canonicalJson(gmailLabelMutationIntent(plan)) !== canonicalJson(intent))
        throw new Error("Gmail label plan conflicts with its intent.");
      const target = plan.target;
      if (target.task?.id !== worker.id || target.task.revision !== worker.revision)
        throw new Error("Gmail label plan has a stale worker.");
      if (!(await gmailLabelActionReferencesCurrent(transaction, ownerId, plan)))
        throw new Error("Gmail label account or preferences changed.");
      return actionRepository(transaction, ownerId).prepare(
        {
          key: requestKey,
          task: worker,
          bindingKey: connectionTargetKey({
            operation: target.operation,
            explicit: { connectionId: target.connectionId, calendarId: null },
          }),
          authorization: {
            target: { kind: "connection", id: target.connectionId, resource: null },
            operation: target.operation,
          },
          arguments: actionRequestSchema.shape.arguments.parse(JSON.parse(canonicalJson(plan))),
        },
        { operationId: plan.operationId },
      );
    },
  };
}
