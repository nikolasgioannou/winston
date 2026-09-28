import { dbConfigSchema } from "@winston/db/config";
import { loadConfig } from "@winston/shared/config";
import { logConfigSchema } from "@winston/shared/logger";
import { z } from "zod";

const gatewayConfigSchema = dbConfigSchema.extend({
  ...logConfigSchema.shape,
  GATEWAY_HOST: z.string().min(1).default("127.0.0.1"),
  /** Local VMs dial ws://host.docker.internal:3001 (`VM_GATEWAY_URL` in agents). */
  GATEWAY_PORT: z.coerce.number().int().positive().default(3001),
  /** Authenticates `agents` to the internal API. Never exposed publicly. */
  GATEWAY_INTERNAL_SECRET: z
    .string()
    .regex(/^[\w-]{32,}$/, "expected at least 32 letters, digits, _ or -"),
});

export function loadGatewayConfig() {
  return loadConfig(gatewayConfigSchema);
}
