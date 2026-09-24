import { z } from "zod";
import { responsibilityPurposeSchema } from "./responsibilities";

export const cliResponsibilityRequestSchema = z.discriminatedUnion("command", [
  responsibilityPurposeSchema.omit({ sourceMessageIds: true }).extend({
    version: z.literal(1),
    command: z.literal("responsibilities.propose"),
    key: z.string().min(1).max(100),
  }),
  z.strictObject({
    version: z.literal(1),
    command: z.literal("responsibilities.list"),
    after: z.uuid().optional(),
  }),
  z.strictObject({
    version: z.literal(1),
    command: z.literal("responsibilities.inspect"),
    id: z.uuid(),
  }),
]);
export type CliResponsibilityRequest = z.infer<typeof cliResponsibilityRequestSchema>;
