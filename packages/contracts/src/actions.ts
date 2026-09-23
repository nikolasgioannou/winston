import { z } from "zod";
import { authorizationRequestSchema, authorizationSnapshotSchema } from "./authorization";

export const actionTaskSchema = z.strictObject({
  id: z.uuid(),
  revision: z.number().int().nonnegative(),
  generation: z.number().int().nonnegative(),
});
export const actionRequestSchema = z.strictObject({
  key: z.string().min(1).max(200),
  task: actionTaskSchema,
  authorization: authorizationRequestSchema,
  arguments: z.json().refine((value) => JSON.stringify(value).length <= 100_000),
});
export const actionStateSchema = z.enum([
  "pending",
  "approved",
  "denied",
  "dispatching",
  "unknown",
  "succeeded",
  "failed",
  "invalidated",
]);
export const actionOutcomeSchema = z.strictObject({
  state: z.enum(["succeeded", "failed", "unknown"]),
  detail: z.string().min(1).max(16_000),
  providerReference: z.string().min(1).max(1024).nullable(),
});
export const actionRecordSchema = z.strictObject({
  id: z.uuid(),
  request: actionRequestSchema,
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  intentRevision: z.number().int().nonnegative(),
  snapshot: authorizationSnapshotSchema.nullable(),
  state: actionStateSchema,
  revision: z.number().int().nonnegative(),
  expiresAt: z.iso.datetime(),
  decisionSource: z.enum(["policy", "owner"]).nullable(),
  operationId: z.uuid(),
  dispatchTask: actionTaskSchema.nullable(),
  outcome: actionOutcomeSchema.nullable(),
});
export const actionDecisionSchema = z.strictObject({
  id: z.uuid(),
  revision: z.number().int().nonnegative(),
  hash: actionRecordSchema.shape.hash,
  approve: z.boolean(),
});
export type ActionRequest = z.infer<typeof actionRequestSchema>;
export type ActionRecord = z.infer<typeof actionRecordSchema>;
export type ActionTask = z.infer<typeof actionTaskSchema>;
export type ActionDecision = z.infer<typeof actionDecisionSchema>;
export type ActionOutcome = z.infer<typeof actionOutcomeSchema>;
