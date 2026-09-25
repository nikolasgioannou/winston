import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { actionRecordSchema, actionTaskSchema, type ActionTask } from "@winston/contracts/actions";
import { deviceOperationSchema } from "@winston/contracts/devices";
import { canonicalJson } from "@winston/contracts/json";
import { taskSchema } from "@winston/contracts/tasks";
import type { DatabaseTransaction } from "./owners";
import { actionRepository } from "./actions";
import { deviceRepository } from "./devices";

export function deviceActionRepository(transaction: DatabaseTransaction, ownerId: string) {
  return {
    async prepare(
      inputTask: ActionTask,
      key: string,
      inputDeviceId: string,
      inputOperation: unknown,
    ) {
      const worker = actionTaskSchema.parse(inputTask);
      const deviceId = actionTaskSchema.shape.id.parse(inputDeviceId);
      const operation = deviceOperationSchema.parse(inputOperation);
      if (!key.length || key.length > 100) throw new Error("Invalid device action key.");
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
      const requestKey = `device:${worker.id}:${String(row.intentRevision)}:${createHash("sha256").update(key).digest("hex")}`;
      const previous = await transaction.execute<{ document: unknown }>(sql`
        SELECT document FROM winston.actions WHERE owner_id = ${ownerId}::uuid AND request_key = ${requestKey}
      `);
      const stored = previous.rows[0];
      if (stored) {
        const action = actionRecordSchema.parse(stored.document);
        const target = action.request.authorization.target;
        if (
          target.kind !== "device" ||
          target.id !== deviceId ||
          target.resource !== null ||
          action.request.authorization.operation !== `device.${operation.kind}` ||
          canonicalJson(action.request.arguments) !== canonicalJson(operation)
        )
          throw new Error("Device action key conflicts with its original target or operation.");
        return action;
      }
      const device = await deviceRepository(transaction, ownerId).find(deviceId);
      if (!device || device.revoked) throw new Error("Device unavailable.");
      return actionRepository(transaction, ownerId).prepare({
        key: requestKey,
        task: worker,
        authorization: {
          target: { kind: "device", id: deviceId, resource: null },
          operation: `device.${operation.kind}`,
        },
        arguments: operation,
      });
    },
  };
}
