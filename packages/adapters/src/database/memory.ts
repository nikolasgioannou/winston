import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  memoryWriteSchema,
  memoryRecordSchema,
  type MemoryWrite,
  type MemoryRecord,
} from "@winston/contracts/memory";
import { userMessageSchema } from "@winston/contracts/messages";
import type { DatabaseTransaction } from "./owners";
import { eventRepository } from "./events";

export function memoryRepository(transaction: DatabaseTransaction, ownerId: string) {
  async function source(id: string) {
    const rows = await transaction.execute<{ envelope: unknown }>(sql`
      SELECT envelope FROM winston.conversation_messages WHERE owner_id = ${ownerId}::uuid AND id = ${id}::uuid
    `);
    if (!rows.rows[0]) throw new Error("Memory source is unavailable to this owner.");

    return userMessageSchema.parse(rows.rows[0].envelope);
  }

  async function taskScope(id: string) {
    const rows = await transaction.execute(
      sql`SELECT id FROM winston.tasks WHERE owner_id = ${ownerId}::uuid AND id = ${id}::uuid`,
    );
    if (!rows.rowCount) throw new Error("Memory task scope is unavailable to this owner.");
  }

  return {
    async remember(input: MemoryWrite, expectedRevision: number | null) {
      const write = memoryWriteSchema.parse(input);
      const owner = await transaction.execute(
        sql`SELECT id FROM winston.owners WHERE id = ${ownerId}::uuid FOR UPDATE`,
      );
      if (!owner.rowCount) throw new Error("Owner is unavailable.");
      if (write.scope.kind === "task") await taskScope(write.scope.id);
      const evidence = await source(write.sourceMessageId);
      const scope = write.scope.kind === "owner" ? "owner" : `task:${write.scope.id}`;
      const current = await transaction.execute<{ document: unknown }>(sql`
        SELECT document FROM winston.memories WHERE owner_id = ${ownerId}::uuid
          AND scope = ${scope} AND memory_key = ${write.key} AND superseded_by IS NULL
      `);
      const previous = current.rows[0]
        ? memoryRecordSchema.parse(current.rows[0].document)
        : undefined;
      if ((previous?.revision ?? null) !== expectedRevision)
        throw new Error("Memory revision is stale.");
      if (previous) {
        if (previous.certainty === "explicit" && write.certainty === "inferred")
          throw new Error("Inferred memory cannot supersede an explicit statement.");
        const oldEvidence = await source(previous.sourceMessageId);
        const observedAt = evidence.provider.editedAt ?? evidence.provider.sentAt;
        const previousObservedAt = oldEvidence.provider.editedAt ?? oldEvidence.provider.sentAt;
        if (observedAt < previousObservedAt)
          throw new Error("Older evidence cannot supersede a newer memory.");
      }
      const record: MemoryRecord = {
        ...write,
        id: randomUUID(),
        ownerId,
        revision: (previous?.revision ?? -1) + 1,
        sourceRevision: evidence.revision,
        createdAt: new Date().toISOString(),
      };
      if (previous)
        await transaction.execute(sql`
        UPDATE winston.memories SET superseded_by = ${record.id}::uuid WHERE owner_id = ${ownerId}::uuid AND id = ${previous.id}::uuid
      `);
      await transaction.execute(sql`
        INSERT INTO winston.memories (owner_id, id, memory_key, scope, document)
        VALUES (${ownerId}::uuid, ${record.id}::uuid, ${record.key}, ${scope}, ${JSON.stringify(record)}::jsonb)
      `);
      await transaction.execute(sql`
        UPDATE winston.conversations SET revision = revision + 1 WHERE owner_id = ${ownerId}::uuid
      `);
      await eventRepository(transaction, ownerId).publish({
        key: record.id,
        type: "memory.changed",
        payload: { memoryId: record.id },
        destinations: ["conversation-updates"],
      });

      return record;
    },
    async explain(id: string) {
      const rows = await transaction.execute<{
        document: unknown;
        supersededBy: string | null;
      }>(sql`
        SELECT document, superseded_by AS "supersededBy" FROM winston.memories WHERE owner_id = ${ownerId}::uuid AND id = ${id}::uuid
      `);
      const row = rows.rows[0];
      if (!row) return undefined;
      const memory = memoryRecordSchema.parse(row.document);
      const evidence = await source(memory.sourceMessageId);

      return {
        memory,
        source: evidence,
        supersededBy: row.supersededBy,
        sourceChanged: evidence.revision !== memory.sourceRevision,
      };
    },
    async search(query: string, taskId?: string) {
      if (!query.trim() || query.length > 300) throw new Error("Invalid memory search.");
      if (taskId !== undefined) await taskScope(taskId);
      const scoped = taskId === undefined ? "owner" : `task:${taskId}`;
      const rows = await transaction.execute<{ document: unknown }>(sql`
        SELECT m.document FROM winston.memories m
        JOIN winston.conversation_messages s ON s.owner_id = m.owner_id AND s.id = (m.document->>'sourceMessageId')::uuid
        WHERE m.owner_id = ${ownerId}::uuid AND m.superseded_by IS NULL AND m.scope IN ('owner', ${scoped})
          AND s.envelope->>'revision' = m.document->>'sourceRevision'
          AND to_tsvector('simple', m.document->>'content') @@ plainto_tsquery('simple', ${query})
        ORDER BY ts_rank(to_tsvector('simple', m.document->>'content'), plainto_tsquery('simple', ${query})) DESC,
          m.document->>'createdAt' DESC, m.id LIMIT 20
      `);

      return rows.rows.map((row) => memoryRecordSchema.parse(row.document));
    },
  };
}

export type MemoryRepository = ReturnType<typeof memoryRepository>;
