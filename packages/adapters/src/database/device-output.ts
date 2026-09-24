import { sql } from "drizzle-orm";
import { actionRecordSchema } from "@winston/contracts/actions";
import {
  deviceOutputByteLimit,
  deviceOutputChunkLimit,
  deviceOutputPageByteLimit,
  deviceOutputCursorSchema,
  type DeviceExecution,
} from "@winston/contracts/device-executions";
import type { DeviceSessionIdentity } from "@winston/contracts/device-registry";
import { deviceMessageSchema, type DeviceMessage } from "@winston/contracts/devices";
import { canonicalJson } from "@winston/contracts/json";
import type { DatabaseTransaction } from "./owners";

export function deviceOutputRepository(
  transaction: DatabaseTransaction,
  ownerId: string,
  execution: {
    find(id: string): Promise<DeviceExecution | null>;
    live(session: DeviceSessionIdentity): Promise<boolean>;
  },
) {
  async function statistics(id: string) {
    const rows = await transaction.execute<{ sequence: number; bytes: number; count: number }>(sql`
      SELECT last_sequence::float8 AS sequence, output_bytes AS bytes, output_count AS count
      FROM winston.device_executions WHERE owner_id = ${ownerId}::uuid AND execution_id = ${id}::uuid
    `);
    return rows.rows[0];
  }

  return {
    async latestSequence(id: string) {
      return (await statistics(id))?.sequence ?? -1;
    },
    async append(input: DeviceMessage) {
      const message = deviceMessageSchema.parse(input);
      const payload = message.payload;
      if (payload.kind !== "output") return false;
      await transaction.execute(
        sql`SELECT id FROM winston.owners WHERE id = ${ownerId}::uuid FOR UPDATE`,
      );
      const current = await execution.find(payload.executionId);
      if (!current || current.message.payload.kind !== "execute") return false;
      const original = current.message;
      const binding = current.message.payload;
      if (
        original.deviceId !== message.deviceId ||
        original.sessionId !== message.sessionId ||
        original.generation !== message.generation ||
        original.messageId !== message.correlationId ||
        binding.taskId !== payload.taskId ||
        binding.taskRevision !== payload.taskRevision ||
        binding.operation.kind !== "command" ||
        !(await execution.live(message))
      )
        return false;
      const previous = await transaction.execute<{ document: unknown }>(sql`
        SELECT document FROM winston.device_output WHERE owner_id = ${ownerId}::uuid
          AND execution_id = ${payload.executionId}::uuid AND sequence = ${payload.sequence}
      `);
      if (previous.rows[0]) {
        const stored = deviceMessageSchema.parse(previous.rows[0].document);
        return canonicalJson(stored.payload) === canonicalJson(payload);
      }
      if (["succeeded", "failed", "canceled"].includes(current.state)) return false;
      const stats = await statistics(payload.executionId);
      const bytes = new TextEncoder().encode(payload.text).byteLength;
      if (
        !stats ||
        payload.sequence <= stats.sequence ||
        stats.count >= deviceOutputChunkLimit ||
        stats.bytes + bytes > deviceOutputByteLimit
      )
        return false;
      await transaction.execute(sql`
        INSERT INTO winston.device_output (owner_id, execution_id, sequence, document)
        VALUES (${ownerId}::uuid, ${payload.executionId}::uuid, ${payload.sequence}, ${JSON.stringify(message)}::jsonb)
      `);
      await transaction.execute(sql`
        UPDATE winston.device_executions SET last_sequence = ${payload.sequence},
          output_bytes = output_bytes + ${bytes}, output_count = output_count + 1
        WHERE owner_id = ${ownerId}::uuid AND execution_id = ${payload.executionId}::uuid
      `);
      return true;
    },
    async list(inputId: string, inputAfter = -1) {
      const id = actionRecordSchema.shape.operationId.parse(inputId);
      const after = deviceOutputCursorSchema.parse(inputAfter);
      const rows = await transaction.execute<{ document: unknown }>(sql`
        SELECT document FROM winston.device_output WHERE owner_id = ${ownerId}::uuid
          AND execution_id = ${id}::uuid AND sequence > ${after}
        ORDER BY sequence LIMIT 17
      `);
      const messages: DeviceMessage[] = [];
      let bytes = 0;
      let afterSequence = after;
      for (const row of rows.rows) {
        const message = deviceMessageSchema.parse(row.document);
        if (message.payload.kind !== "output") throw new Error("Invalid stored device output.");
        const length = new TextEncoder().encode(message.payload.text).byteLength;
        if (messages.length === 16 || bytes + length > deviceOutputPageByteLimit) break;
        messages.push(message);
        bytes += length;
        afterSequence = message.payload.sequence;
      }
      return { messages, afterSequence, hasMore: messages.length < rows.rows.length };
    },
  };
}
