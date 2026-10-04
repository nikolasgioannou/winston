/**
 * The sites kill switch (docs/design.md §9a, docs/runbooks/sites.md):
 *
 *   bun run sites:switch pause-all    every running site shows its paused page
 *   bun run sites:switch resume-all   undoes it (sites paused for a cap stay paused)
 *
 * Works on whatever DATABASE_URL and the site host config (Cloudflare, or
 * SITES_ADMIN_URL locally) point at; `bun run prod sites` runs it in production.
 */
import { createDb } from "@winston/db/client";
import { loadDbConfig } from "@winston/db/config";
import { siteHostConfigSchema, siteHostFrom } from "@winston/site-host/config";
import { pauseAllSites, resumeAllSites } from "@winston/site-host/usage";

const [command] = process.argv.slice(2);
const host = siteHostFrom(siteHostConfigSchema.parse(process.env));
if ((command !== "pause-all" && command !== "resume-all") || !host) {
  console.error(
    "Usage: bun run sites:switch pause-all | resume-all (with a site host configured)",
  );
  process.exit(1);
}
const db = createDb(loadDbConfig().DATABASE_URL);
const count =
  command === "pause-all"
    ? await pauseAllSites(db, host)
    : await resumeAllSites(db, host);
console.log(
  command === "pause-all"
    ? `Paused ${String(count)} site${count === 1 ? "" : "s"}.`
    : `Resumed ${String(count)} site${count === 1 ? "" : "s"}.`,
);
process.exit(0);
