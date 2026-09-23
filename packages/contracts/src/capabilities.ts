import { z } from "zod";

export const serviceKindSchema = z.enum(["worker", "workspace", "device"]);
export const serviceOperationSchema = z.enum([
  "workspace:execute",
  "workspace:observe",
  "workspace:cancel",
  "artifact:upload",
  "artifact:download",
  "connector:read",
  "connector:write",
  "device:execute",
]);
export const workspaceControlOperationSchema = z.enum(["workspace:observe", "workspace:cancel"]);
export const serviceScopeSchema = z
  .strictObject({
    kind: serviceKindSchema,
    subjectId: z.uuid(),
    taskId: z.uuid(),
    revision: z.number().int().nonnegative(),
    generation: z.number().int().nonnegative(),
    operation: serviceOperationSchema,
    resourceId: z.uuid(),
    resourceRevision: z.number().int().nonnegative().optional(),
    executionId: z.uuid().optional(),
    credential: z
      .strictObject({ id: z.uuid(), revision: z.number().int().nonnegative() })
      .nullable(),
  })
  .refine(
    (scope) =>
      workspaceControlOperationSchema.safeParse(scope.operation).success ===
      (scope.executionId !== undefined),
  );
export const serviceRequestSchema = z.strictObject({
  token: z.string().regex(/^wst_[A-Za-z0-9_-]{43}$/),
  kind: serviceKindSchema,
  subjectId: z.uuid(),
  operation: serviceOperationSchema,
  resourceId: z.uuid(),
});
export type ServiceScope = z.infer<typeof serviceScopeSchema>;
export type ServiceRequest = z.infer<typeof serviceRequestSchema>;
