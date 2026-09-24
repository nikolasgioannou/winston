import { z } from "zod";

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
