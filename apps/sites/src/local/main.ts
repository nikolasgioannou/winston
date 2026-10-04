/**
 * The dev stack's `sites` service (docs/local-dev.md): serves sites at
 * http://<name>.sites.localhost:3003, with the admin API on 3004.
 */
import { join } from "node:path";
import { createLogger } from "@winston/shared/logger";
import { startLocalSites } from "./server.ts";

const log = createLogger("sites");

const sites = await startLocalSites({
  dir: join(import.meta.dir, "../../../../.data/sites"),
  domain: process.env.SITES_DOMAIN ?? "sites.localhost",
  port: Number(process.env.SITES_PORT ?? 3003),
  adminPort: Number(process.env.SITES_ADMIN_PORT ?? 3004),
});
log.info({ url: sites.url, adminUrl: sites.adminUrl }, "serving sites");

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    void sites.stop().then(() => process.exit(0));
  });
