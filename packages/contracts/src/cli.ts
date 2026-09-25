import { z } from "zod";
import { artifactStageRequestSchema } from "./artifacts";
import { googleServiceSchema } from "./connections";
import { cliReadRequestSchema } from "./cli-reads";
import { cliScheduleRequestSchema } from "./cli-schedules";
import { cliResponsibilityRequestSchema } from "./cli-responsibilities";
import { cliDeviceRequestSchema } from "./cli-devices";
import { cliGmailLabelMutationRequestSchema } from "./cli-gmail-labels";
import { cliGmailTrashRequestSchema } from "./cli-gmail-trash";
export { cliGmailLabelMutationRequestSchema } from "./cli-gmail-labels";
import {
  cliGmailMutationRequestSchema,
  cliGmailReconciliationRequestSchema,
} from "./cli-gmail-mutations";
export {
  cliGmailMutationRequestSchema,
  cliGmailReconciliationRequestSchema,
  type CliGmailReconciliationRequest,
  gmailMutationInputFromCli,
  type CliGmailMutationRequest,
} from "./cli-gmail-mutations";
import {
  cliCalendarMutationRequestSchema,
  cliCalendarReconciliationRequestSchema,
} from "./cli-calendar-mutations";
export {
  cliCalendarReconciliationRequestSchema,
  type CliCalendarReconciliationRequest,
  cliCalendarMutationRequestSchema,
  calendarMutationInputFromCli,
  type CliCalendarMutationRequest,
} from "./cli-calendar-mutations";
export {
  cliDeviceRequestSchema,
  cliDeviceResultSchema,
  deviceCommandTimeoutMs,
  type CliDeviceRequest,
} from "./cli-devices";
export {
  cliResponsibilityRequestSchema,
  type CliResponsibilityRequest,
} from "./cli-responsibilities";
export {
  cliScheduleRequestSchema,
  isScheduleMutation,
  type CliScheduleRequest,
} from "./cli-schedules";
export { cliReadRequestSchema, type CliReadRequest } from "./cli-reads";

export const cliRequestSchema = z.discriminatedUnion("command", [
  artifactStageRequestSchema.extend({ command: z.literal("files.stage") }),
  ...cliGmailTrashRequestSchema.options,
  cliGmailLabelMutationRequestSchema,
  cliGmailReconciliationRequestSchema,
  ...cliGmailMutationRequestSchema.options,
  cliCalendarReconciliationRequestSchema,
  ...cliCalendarMutationRequestSchema.options,
  ...cliDeviceRequestSchema.options,
  ...cliResponsibilityRequestSchema.options,
  ...cliScheduleRequestSchema.options,
  z.strictObject({
    version: z.literal(1),
    command: z.literal("files.send"),
    id: z.uuid(),
    key: z.string().min(1).max(100),
  }),
  z.strictObject({ version: z.literal(1), command: z.literal("files.status"), id: z.uuid() }),
  z.strictObject({
    version: z.literal(1),
    command: z.literal("files.publish"),
    path: z.string().min(1).max(4096),
    key: z.string().min(1).max(100),
    mediaType: z.string().min(1).max(255).default("application/octet-stream"),
  }),
  z.strictObject({
    version: z.literal(1),
    command: z.literal("files.inspect"),
    path: z.string().min(1).max(4096),
  }),
  ...cliReadRequestSchema.options,
  z.strictObject({ version: z.literal(1), command: z.literal("accounts.list") }),
  z.strictObject({ version: z.literal(1), command: z.literal("accounts.inspect"), id: z.uuid() }),
  z.strictObject({
    version: z.literal(1),
    command: z.literal("accounts.resolve"),
    service: googleServiceSchema,
    alias: z.string().trim().min(1).max(1024),
  }),
  z.strictObject({
    version: z.literal(1),
    command: z.literal("accounts.connect"),
    service: googleServiceSchema,
    id: z.uuid().optional(),
    key: z.string().min(1).max(100),
    detail: z.string().min(1).max(2000),
  }),
  z.strictObject({ version: z.literal(1), command: z.literal("devices.list") }),
  z.strictObject({ version: z.literal(1), command: z.literal("devices.inspect"), id: z.uuid() }),
  z.strictObject({ version: z.literal(1), command: z.literal("operations.inspect"), id: z.uuid() }),
  z.strictObject({ version: z.literal(1), command: z.literal("operations.cancel"), id: z.uuid() }),
]);

export const cliResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ version: z.literal(1), status: z.literal("ok"), data: z.json() }),
  z.strictObject({
    version: z.literal(1),
    status: z.enum([
      "invalid_input",
      "denied",
      "approval_required",
      "waiting",
      "unavailable",
      "unknown",
    ]),
    message: z.string().min(1).max(2000),
    referenceId: z.uuid().optional(),
  }),
]);

export type CliRequest = z.infer<typeof cliRequestSchema>;
export function cliCommandInputSchema(command: string) {
  const schema = cliRequestSchema.options.find((option) => option.shape.command.value === command);
  if (!schema) throw new Error("Unknown CLI command.");
  return z.record(z.string(), z.json()).parse({
    ...z.toJSONSchema(schema, { io: "input" }),
    description:
      "Structural input schema. Runtime validation also enforces semantic constraints and current authority.",
  });
}
export const cliAuthoritySchema = z.strictObject({
  version: z.literal(1),
  environment: z.enum(["production", "local"]),
  workspaceId: z.uuid(),
  token: z.string().regex(/^wst_[A-Za-z0-9_-]{43}$/),
  controlToken: z
    .string()
    .regex(/^wst_[A-Za-z0-9_-]{43}$/)
    .optional(),
  expiresAt: z.iso.datetime(),
});
export type CliAuthority = z.infer<typeof cliAuthoritySchema>;
export type CliResult = z.infer<typeof cliResultSchema>;

export const cliExitCodes = {
  ok: 0,
  invalid_input: 2,
  denied: 3,
  approval_required: 4,
  waiting: 5,
  unavailable: 6,
  unknown: 7,
} as const satisfies Record<CliResult["status"], number>;
