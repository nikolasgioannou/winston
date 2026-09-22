import { z } from "zod";

export const serviceKindSchema = z.enum(["worker", "workspace", "device"]);
export const serviceOperationSchema = z.enum([
  "workspace:execute",
  "artifact:upload",
  "artifact:download",
  "connector:read",
  "connector:write",
  "device:execute",
]);
export const serviceScopeSchema = z.strictObject({
  kind: serviceKindSchema,
  subjectId: z.uuid(),
  taskId: z.uuid(),
  revision: z.number().int().nonnegative(),
  generation: z.number().int().nonnegative(),
  operation: serviceOperationSchema,
  resourceId: z.uuid(),
  credential: z.strictObject({ id: z.uuid(), revision: z.number().int().nonnegative() }).nullable(),
});
export const serviceRequestSchema = z.strictObject({
  token: z.string().regex(/^wst_[A-Za-z0-9_-]{43}$/),
  kind: serviceKindSchema,
  subjectId: z.uuid(),
  operation: serviceOperationSchema,
  resourceId: z.uuid(),
});
export type ServiceScope = z.infer<typeof serviceScopeSchema>;
export type ServiceRequest = z.infer<typeof serviceRequestSchema>;
