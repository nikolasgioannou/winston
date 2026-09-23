import { z } from "zod";
import { actionTaskSchema } from "./actions";
import { googleServiceSchema } from "./connections";

export const handoffTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("connection"),
    service: googleServiceSchema,
    connectionId: z.uuid().nullable(),
  }),
  z.strictObject({ kind: z.literal("browser"), sessionId: z.uuid() }),
]);
export const handoffRequestSchema = z.strictObject({
  key: z.string().min(1).max(200),
  task: actionTaskSchema,
  target: handoffTargetSchema,
  detail: z.string().min(1).max(2000),
});
export const handoffSchema = z.strictObject({
  id: z.uuid(),
  taskId: z.uuid(),
  taskRevision: z.number().int().nonnegative(),
  intentRevision: z.number().int().nonnegative(),
  target: handoffTargetSchema,
  detail: handoffRequestSchema.shape.detail,
  state: z.enum(["pending", "completed", "abandoned", "expired", "invalidated"]),
  expiresAt: z.iso.datetime(),
  resolutionId: z.uuid().nullable(),
});
export const handoffEvidenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("connection"), connectionId: z.uuid() }),
  z.strictObject({ kind: z.literal("browser"), sessionId: z.uuid() }),
]);
export type Handoff = z.infer<typeof handoffSchema>;
export type HandoffRequest = z.infer<typeof handoffRequestSchema>;
export type HandoffEvidence = z.infer<typeof handoffEvidenceSchema>;
