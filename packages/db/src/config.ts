import { loadConfig } from "@winston/shared/config";
import { z } from "zod";

export const dbConfigSchema = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  /**
   * Production: the RDS-managed secret with the password, which then stays
   * out of DATABASE_URL (see `createDb`).
   */
  DATABASE_SECRET_ARN: z
    .string()
    .startsWith("arn:aws:secretsmanager:")
    .optional(),
});

/** Reads and validates the database settings from the environment. */
export function loadDbConfig(env?: Record<string, string | undefined>) {
  return loadConfig(dbConfigSchema, env);
}

/** Throws unless `databaseUrl` points at this machine. Guards local-only tools. */
export function assertLocalDatabase(databaseUrl: string, action: string) {
  const { hostname } = new URL(databaseUrl);
  if (hostname !== "localhost" && hostname !== "127.0.0.1") {
    throw new Error(
      `Refusing to ${action} a non-local database (${hostname}).`,
    );
  }
}
