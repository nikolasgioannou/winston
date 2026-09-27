import { dbConfigSchema } from "@winston/db/config";
import { loadConfig } from "@winston/shared/config";
import { logConfigSchema } from "@winston/shared/logger";
import { z } from "zod";

const agentsConfigSchema = dbConfigSchema.extend({
  ...logConfigSchema.shape,
  /** How many jobs this process runs at once. */
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(4),
  /** How long in-flight jobs get to finish on shutdown before the process exits anyway. */
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
});

export function loadAgentsConfig() {
  return loadConfig(agentsConfigSchema);
}
