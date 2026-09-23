import { z } from "zod";

export const commandInputSchema = z
  .strictObject({
    argv: z
      .array(
        z
          .string()
          .max(8192)
          .refine((value) => !value.includes("\0")),
      )
      .min(1)
      .max(128),
    cwd: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => value.startsWith("/") && !value.includes("\0")),
    env: z.record(
      z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
      z
        .string()
        .max(8192)
        .refine((value) => !value.includes("\0")),
    ),
    timeoutMs: z.number().int().min(1).max(86_400_000),
    maxOutputBytes: z
      .number()
      .int()
      .min(1024)
      .max(256 * 1024 * 1024)
      .default(64 * 1024 * 1024),
  })
  .refine(
    (value) =>
      value.argv[0] !== "" && new TextEncoder().encode(JSON.stringify(value)).byteLength <= 12_000,
  );

export const commandExitSchema = z.strictObject({
  exitCode: z.number().int().nullable(),
  signal: z.string().max(32).nullable(),
});
export type CommandInput = z.infer<typeof commandInputSchema>;
export type CommandExit = z.infer<typeof commandExitSchema>;

export const commandOutputSchema = z.strictObject({
  bytes: z
    .number()
    .int()
    .min(0)
    .max(256 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  preview: z.string().max(4096),
  truncated: z.boolean(),
});
export const commandResultSchema = commandExitSchema.extend({
  reason: z.enum(["exited", "canceled", "timeout", "output_limit", "unknown"]),
  durationMs: z.number().int().nonnegative(),
  stdout: commandOutputSchema,
  stderr: commandOutputSchema,
});
export const commandOutputChannelSchema = z.enum(["stdout", "stderr"]);
export type CommandOutput = z.infer<typeof commandOutputSchema>;
export type CommandResult = z.infer<typeof commandResultSchema>;
export type CommandOutputChannel = z.infer<typeof commandOutputChannelSchema>;
