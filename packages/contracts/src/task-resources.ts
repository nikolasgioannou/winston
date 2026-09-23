import { z } from "zod";
import { authorizationRequestSchema } from "./authorization";

export const taskResourceKeySchema = z.string().regex(/^[a-z0-9][a-z0-9:._-]{0,99}$/);
export const taskResourceScopeSchema = z.strictObject({
  id: z.uuid(),
  revision: z.number().int().nonnegative(),
});
export const taskResourceRequestSchema = z.strictObject({
  task: taskResourceScopeSchema,
  key: taskResourceKeySchema,
  authorization: authorizationRequestSchema,
});
export const taskResourceBindingSchema = z.strictObject({
  taskId: z.uuid(),
  intentRevision: z.number().int().nonnegative(),
  key: taskResourceKeySchema,
  authorization: authorizationRequestSchema,
  resourceRevision: z.number().int().nonnegative(),
});
export type TaskResourceScope = z.infer<typeof taskResourceScopeSchema>;
export type TaskResourceRequest = z.infer<typeof taskResourceRequestSchema>;
export type TaskResourceBinding = z.infer<typeof taskResourceBindingSchema>;
