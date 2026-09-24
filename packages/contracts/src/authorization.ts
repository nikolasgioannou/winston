import { z } from "zod";

export const authorizationOperationSchema = z.enum([
  "gmail.read",
  "gmail.draft",
  "gmail.send",
  "gmail.modify",
  "calendar.list",
  "calendar.read",
  "calendar.write",
  "device.command",
  "device.file.read",
  "device.file.write",
  "device.observe",
  "device.input",
  "device.application",
  "workspace.command",
  "workspace.file.read",
  "workspace.file.write",
]);
export const authorizationTargetSchema = z.strictObject({
  kind: z.enum(["connection", "device", "workspace"]),
  id: z.uuid(),
  resource: z.string().min(1).max(1024).nullable(),
});
export const authorizationRequestSchema = z.strictObject({
  target: authorizationTargetSchema,
  operation: authorizationOperationSchema,
});
export const authorizationRuleSchema = authorizationRequestSchema.extend({
  decision: z.enum(["allow", "ask", "deny"]),
});
export const authorizationUpdateSchema = authorizationRuleSchema.extend({
  revision: z.number().int().nonnegative(),
});
export const authorizationRulesSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  rules: z.array(authorizationRuleSchema),
});
export const authorizationReceiptSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
});
export type AuthorizationRules = z.infer<typeof authorizationRulesSchema>;
export const authorizationSnapshotSchema = authorizationRequestSchema.extend({
  revision: z.number().int().nonnegative(),
  resourceRevision: z.number().int().nonnegative(),
});
export const authorizationEvaluationSchema = z.strictObject({
  decision: z.enum(["allow", "ask", "deny"]),
  reason: z.enum([
    "rule",
    "workspace_default",
    "confirmation_required",
    "unavailable",
    "unsupported",
    "stale",
  ]),
  revision: z.number().int().nonnegative(),
  resourceRevision: z.number().int().nonnegative().nullable(),
  broadAuthority: z.boolean(),
  snapshot: authorizationSnapshotSchema.nullable(),
});
export type AuthorizationRequest = z.infer<typeof authorizationRequestSchema>;
export type AuthorizationUpdate = z.infer<typeof authorizationUpdateSchema>;
export type AuthorizationEvaluation = z.infer<typeof authorizationEvaluationSchema>;
export type AuthorizationSnapshot = z.infer<typeof authorizationSnapshotSchema>;
