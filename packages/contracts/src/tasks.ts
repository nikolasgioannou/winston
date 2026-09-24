import { z } from "zod";
import { actionStateSchema } from "./actions";
import { authorizationRequestSchema } from "./authorization";

export const taskBlockerSchema = z.strictObject({
  kind: z.enum([
    "approval",
    "connection",
    "browser",
    "device",
    "workspace",
    "execution",
    "responsibility",
  ]),
  referenceId: z.uuid(),
  detail: z.string().min(1).max(2000),
});

export const taskRequestSchema = z.strictObject({
  key: z.string().min(1).max(200),
  objective: z.string().min(1).max(20_000),
  sourceMessageIds: z.array(z.uuid()).max(100),
});

export const taskSchema = z.strictObject({
  id: z.uuid(),
  ownerId: z.uuid(),
  objective: taskRequestSchema.shape.objective,
  sourceMessageIds: taskRequestSchema.shape.sourceMessageIds,
  revision: z.number().int().nonnegative(),
  generation: z.number().int().nonnegative(),
  state: z.enum(["queued", "running", "waiting", "succeeded", "failed", "canceled"]),
  blocker: taskBlockerSchema.nullable(),
  result: z.string().max(100_000).nullable(),
});

export const taskOutcomeSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("waiting"), blocker: taskBlockerSchema }),
  z.strictObject({ state: z.literal("succeeded"), result: z.string().min(1).max(100_000) }),
  z.strictObject({ state: z.literal("failed"), result: z.string().min(1).max(100_000) }),
]);

export type Task = z.infer<typeof taskSchema>;
export type TaskRequest = z.infer<typeof taskRequestSchema>;
export type TaskOutcome = z.infer<typeof taskOutcomeSchema>;

export const taskActivityCursorSchema = z.strictObject({
  createdAt: z.iso.datetime({ precision: 6 }),
  id: z.uuid(),
});
export type TaskActivityCursor = z.infer<typeof taskActivityCursorSchema>;
export const taskActivitySchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        id: z.uuid(),
        revision: taskSchema.shape.revision,
        createdAt: z.iso.datetime(),
        updatedAt: z.iso.datetime(),
        objective: z.string().max(2000),
        objectiveTruncated: z.boolean(),
        state: taskSchema.shape.state,
        waiting: taskBlockerSchema.omit({ referenceId: true }).nullable(),
        result: z.string().max(4000).nullable(),
        resultTruncated: z.boolean(),
      }),
    )
    .max(20),
  next: taskActivityCursorSchema.nullable(),
});
export type TaskActivity = z.infer<typeof taskActivitySchema>;

export const taskDetailSchema = taskActivitySchema.shape.items.element
  .omit({ objectiveTruncated: true, resultTruncated: true })
  .extend({ objective: taskSchema.shape.objective, result: taskSchema.shape.result });
export type TaskDetail = z.infer<typeof taskDetailSchema>;
export const taskHistoryCursorSchema = z.number().int().min(0).max(2147483647);
export const taskHistorySchema = z.strictObject({
  items: taskActivitySchema.shape.items,
  next: taskHistoryCursorSchema.nullable(),
});
export type TaskHistory = z.infer<typeof taskHistorySchema>;

export const taskActionEvidenceSchema = z.strictObject({
  unresolved: z.number().int().nonnegative(),
  items: z
    .array(
      z.strictObject({
        id: z.uuid(),
        intentRevision: z.number().int().nonnegative(),
        authorization: authorizationRequestSchema,
        state: actionStateSchema,
        decisionSource: z.enum(["policy", "owner"]).nullable(),
        expiresAt: z.iso.datetime(),
      }),
    )
    .max(20),
  next: z.uuid().nullable(),
});
export type TaskActionEvidence = z.infer<typeof taskActionEvidenceSchema>;
export const ownerTaskCancelSchema = z.strictObject({ revision: taskSchema.shape.revision });
