import { z } from "zod";

export const connectionOperationSchema = z.enum([
  "gmail.read",
  "gmail.draft",
  "gmail.send",
  "gmail.modify",
  "calendar.read",
  "calendar.write",
]);
export const connectionTargetSchema = z.strictObject({
  connectionId: z.uuid(),
  calendarId: z.string().min(1).max(1024).nullable(),
});
export const targetPreferencesSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  labels: z
    .array(
      z.strictObject({
        target: connectionTargetSchema,
        label: z.string().trim().min(1).max(120),
      }),
    )
    .max(500),
  defaults: z
    .array(
      z.strictObject({
        operation: connectionOperationSchema,
        target: connectionTargetSchema,
      }),
    )
    .max(6),
});
export const targetSelectionSchema = z.strictObject({
  operation: connectionOperationSchema,
  explicit: connectionTargetSchema.optional(),
  task: z.strictObject({ id: z.uuid(), revision: z.number().int().nonnegative() }).optional(),
});
export const resolvedTargetSchema = connectionTargetSchema.extend({
  operation: connectionOperationSchema,
  connectionRevision: z.number().int().nonnegative(),
  preferencesRevision: z.number().int().nonnegative(),
  task: targetSelectionSchema.shape.task,
  label: z.string(),
  email: z.email(),
});
export type ConnectionOperation = z.infer<typeof connectionOperationSchema>;
export type ConnectionTarget = z.infer<typeof connectionTargetSchema>;
export type TargetPreferences = z.infer<typeof targetPreferencesSchema>;
export type TargetSelection = z.infer<typeof targetSelectionSchema>;
export type ResolvedTarget = z.infer<typeof resolvedTargetSchema>;
