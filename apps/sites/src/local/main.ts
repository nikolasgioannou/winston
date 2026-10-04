/**
 * The dev stack's `sites` service (docs/local-dev.md): serves sites at
 * http://<name>.sites.localhost:3003, with the admin API on 3004.
 */
import { join } from "node:path";
import {
  sitePassPublicKey,
  sitePassSigningKey,
} from "@winston/site-host/pass-sign";
import { createLogger } from "@winston/shared/logger";
import { startLocalSites } from "./server.ts";
// Not used here: the import makes `bun --watch` restart the service when the
// dispatch Worker changes, since the server bundles it with Bun.build.
import "../dispatch/local.ts";

const log = createLogger("sites");

const passKey = process.env.SITES_PASS_KEY;
if (!passKey) {
  log.error("SITES_PASS_KEY isn't set. Run ./scripts/setup.sh to generate it.");
  process.exit(1);
}

const sites = await startLocalSites({
  dir: join(import.meta.dir, "../../../../.data/sites"),
  domain: process.env.SITES_DOMAIN ?? "sites.localhost",
  port: Number(process.env.SITES_PORT ?? 3003),
  adminPort: Number(process.env.SITES_ADMIN_PORT ?? 3004),
  webUrl: process.env.WEB_PUBLIC_URL ?? "http://localhost:3002",
  // Locally the public half comes from the same key the site signs with.
  passPublicKey: sitePassPublicKey(sitePassSigningKey(passKey)),
});
log.info({ url: sites.url, adminUrl: sites.adminUrl }, "serving sites");

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    void sites.stop().then(() => process.exit(0));
  });
