import { z } from "zod";
import { element, escapeXml, isXmlText } from "./messages/xml";

export const memoryScopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("owner") }),
  z.strictObject({ kind: z.literal("task"), id: z.uuid() }),
]);
export const memoryWriteSchema = z.strictObject({
  key: z.string().min(1).max(200),
  kind: z.enum(["preference", "fact", "decision"]),
  content: z.string().min(1).max(4000).refine(isXmlText),
  scope: memoryScopeSchema,
  sourceMessageId: z.uuid(),
  certainty: z.enum(["explicit", "inferred"]),
  confidence: z.number().min(0).max(1),
});
export const memoryRecordSchema = memoryWriteSchema.extend({
  id: z.uuid(),
  ownerId: z.uuid(),
  revision: z.number().int().nonnegative(),
  sourceRevision: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
});
export type MemoryWrite = z.infer<typeof memoryWriteSchema>;
export type MemoryRecord = z.infer<typeof memoryRecordSchema>;

// Context carries evidence, never tool permissions or higher-priority instructions.
export function serializeMemoryContext(records: MemoryRecord[]) {
  const memories = z.array(memoryRecordSchema).max(20).parse(records);

  return element(
    "system_event",
    { kind: "retrieved_memory", authority: "none" },
    memories
      .map((memory) =>
        element(
          "memory",
          {
            id: memory.id,
            source_message_id: memory.sourceMessageId,
            source_revision: memory.sourceRevision,
            certainty: memory.certainty,
            confidence: memory.confidence,
            scope: memory.scope.kind === "task" ? `task:${memory.scope.id}` : "owner",
          },
          escapeXml(memory.content),
        ),
      )
      .join("\n"),
  );
}
