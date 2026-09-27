import { loadConfig } from "@winston/shared/config";
import { z } from "zod";

export const dbConfigSchema = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
});

/** Reads and validates the database settings from the environment. */
export function loadDbConfig(env?: Record<string, string | undefined>) {
  return loadConfig(dbConfigSchema, env);
}
