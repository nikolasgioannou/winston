import { z } from "zod";

export const cliRequestSchema = z.discriminatedUnion("command", [
  z.strictObject({ version: z.literal(1), command: z.literal("accounts.list") }),
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
export const cliAuthoritySchema = z.strictObject({
  version: z.literal(1),
  environment: z.enum(["production", "local"]),
  workspaceId: z.uuid(),
  token: z.string().regex(/^wst_[A-Za-z0-9_-]{43}$/),
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
