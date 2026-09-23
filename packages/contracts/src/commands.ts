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

export type CommandOutput = {
  bytes: number;
  sha256: string;
  preview: string;
  truncated: boolean;
};
export type CommandResult = CommandExit & {
  reason: "exited" | "canceled" | "timeout" | "output_limit" | "unknown";
  durationMs: number;
  stdout: CommandOutput;
  stderr: CommandOutput;
};
