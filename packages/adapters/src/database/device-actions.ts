import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { actionRecordSchema, actionTaskSchema, type ActionTask } from "@winston/contracts/actions";
import { deviceOperationSchema } from "@winston/contracts/devices";
import { canonicalJson } from "@winston/contracts/json";
import { taskSchema } from "@winston/contracts/tasks";
import type { DatabaseTransaction } from "./owners";
import { actionRepository } from "./actions";
import { deviceRepository } from "./devices";

export class DeviceActionPreparationError extends Error {
  constructor(readonly reason: "conflict" | "unavailable") {
    super(
      reason === "conflict"
        ? "Device action key conflicts with its original target or operation."
        : "Device unavailable.",
    );
  }
}

export function deviceActionRepository(transaction: DatabaseTransaction, ownerId: string) {
  async function prepare(
    inputTask: ActionTask,
    key: string,
    inputDeviceId: string,
    input: { kind: "operation"; value: unknown } | { kind: "file.read"; path: string },
  ) {
    const worker = actionTaskSchema.parse(inputTask);
    const deviceId = actionTaskSchema.shape.id.parse(inputDeviceId);
    const requested =
      input.kind === "operation"
        ? deviceOperationSchema.parse(input.value)
        : deviceOperationSchema.options[1].shape.path.parse(input.path);
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
    const action = stored ? actionRecordSchema.parse(stored.document) : null;
    const prior = action ? deviceOperationSchema.safeParse(action.request.arguments) : null;
    const operation =
      typeof requested === "string"
        ? deviceOperationSchema.parse({
            kind: "file.read",
            path: requested,
            transferId:
              prior?.success && prior.data.kind === "file.read"
                ? prior.data.transferId
                : randomUUID(),
          })
        : requested;
    if (action) {
      const target = action.request.authorization.target;
      if (
        target.kind !== "device" ||
        target.id !== deviceId ||
        target.resource !== null ||
        action.request.authorization.operation !== `device.${operation.kind}` ||
        canonicalJson(action.request.arguments) !== canonicalJson(operation)
      )
        throw new DeviceActionPreparationError("conflict");
      return action;
    }
    const device = await deviceRepository(transaction, ownerId).find(deviceId);
    if (!device || device.revoked) throw new DeviceActionPreparationError("unavailable");
    return actionRepository(transaction, ownerId).prepare({
      key: requestKey,
      task: worker,
      authorization: {
        target: { kind: "device", id: deviceId, resource: null },
        operation: `device.${operation.kind}`,
      },
      arguments: operation,
    });
  }
  return {
    prepare(task: ActionTask, key: string, deviceId: string, operation: unknown) {
      return prepare(task, key, deviceId, {
        kind: "operation",
        value: operation,
      });
    },
    prepareFileRead(task: ActionTask, key: string, deviceId: string, path: string) {
      return prepare(task, key, deviceId, { kind: "file.read", path });
    },
  };
}
