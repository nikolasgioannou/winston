import { dbConfigSchema } from "@winston/db/config";
import { loadConfig } from "@winston/shared/config";
import { logConfigSchema } from "@winston/shared/logger";
import { z } from "zod";
import { telegramConfigSchema } from "./telegram/config.ts";

const apiConfigSchema = dbConfigSchema.extend({
  ...logConfigSchema.shape,
  ...telegramConfigSchema.shape,
  API_HOST: z.string().min(1).default("127.0.0.1"),
  API_PORT: z.coerce.number().int().positive().default(3000),
  /** Gmail push (both or neither): the OIDC audience and signing service account Pub/Sub uses. */
  GMAIL_PUSH_AUDIENCE: z.url().optional(),
  GMAIL_PUSH_SERVICE_ACCOUNT: z.email().optional(),
});

export function loadApiConfig() {
  return loadConfig(apiConfigSchema);
}
