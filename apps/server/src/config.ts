import { z } from "zod";

const schema = z.object({
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(0).max(65535).default(3001),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1).max(120_000).default(10_000),
});

export function readConfig(environment: Record<string, string | undefined>) {
  const result = schema.safeParse(environment);

  if (!result.success) {
    const fields = result.error.issues.map((issue) => issue.path.join("."));

    // Report field names only; environment values may contain credentials.
    throw new Error(`Invalid server configuration: ${fields.join(", ")}`);
  }

  return {
    hostname: result.data.HOST,
    port: result.data.PORT,
    shutdownTimeoutMs: result.data.SHUTDOWN_TIMEOUT_MS,
  };
}

export type ServerConfig = ReturnType<typeof readConfig>;
