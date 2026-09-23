import { z } from "zod";

export const workspaceIdentitySchema = z.strictObject({
  ownerId: z.uuid(),
  workspaceId: z.uuid(),
});

export const workspaceStateSchema = z.enum(["paused", "active", "retired"]);
export const registeredWorkspaceSchema = z.strictObject({
  id: z.uuid(),
  name: z.string().trim().min(1).max(100),
  state: workspaceStateSchema,
  revision: z.number().int().nonnegative(),
});

export const workspaceWorkerSchema = z.strictObject({
  workerId: z.uuid(),
  workspaceId: z.uuid(),
  taskId: z.uuid(),
  revision: z.number().int().nonnegative(),
  generation: z.number().int().nonnegative(),
});

export const workspaceOperationSchema = z.strictObject({
  version: z.literal(1),
  identity: workspaceIdentitySchema,
  operationId: z.uuid(),
  taskId: z.uuid(),
  revision: z.number().int().nonnegative(),
  generation: z.number().int().nonnegative(),
  kind: z.enum(["workspace:inspect", "command:execute", "file:read", "file:write"]),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
});

export const workspaceOutcomeSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("completed"), result: z.string().max(16_000) }),
  z.strictObject({ state: z.literal("failed"), code: z.string().regex(/^[a-z_]{1,80}$/) }),
]);

export const workspaceRecordSchema = z.strictObject({
  request: workspaceOperationSchema,
  state: z.enum(["running", "completed", "failed", "unknown"]),
  outcome: workspaceOutcomeSchema.nullable(),
});

export const workspaceAuthorizationSchema = z.strictObject({
  version: z.literal(1),
  allowed: z.literal(true),
  operation: workspaceOperationSchema,
  workspaceRevision: z.number().int().nonnegative(),
});

export type WorkspaceIdentity = z.infer<typeof workspaceIdentitySchema>;
export type WorkspaceOperation = z.infer<typeof workspaceOperationSchema>;
export type WorkspaceOutcome = z.infer<typeof workspaceOutcomeSchema>;
export type WorkspaceRecord = z.infer<typeof workspaceRecordSchema>;
export type RegisteredWorkspace = z.infer<typeof registeredWorkspaceSchema>;
export type WorkspaceWorker = z.infer<typeof workspaceWorkerSchema>;
