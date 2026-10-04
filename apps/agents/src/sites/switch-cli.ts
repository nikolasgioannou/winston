/**
 * The sites kill switch (docs/design.md §9a, docs/runbooks/sites.md):
 *
 *   bun run sites:switch pause-all    every running site shows its paused page
 *   bun run sites:switch resume-all   undoes it (sites paused for a cap stay paused)
 *
 * Works on whatever DATABASE_URL and SITES_ADMIN_URL point at.
 */
import { createDb } from "@winston/db/client";
import { loadDbConfig } from "@winston/db/config";
import { localSiteHost } from "@winston/site-host/local-host";
import { pauseAllSites, resumeAllSites } from "@winston/site-host/usage";

const [command] = process.argv.slice(2);
const adminUrl = process.env.SITES_ADMIN_URL;
if ((command !== "pause-all" && command !== "resume-all") || !adminUrl) {
  console.error(
    "Usage: bun run sites:switch pause-all | resume-all (with SITES_ADMIN_URL set)",
  );
  process.exit(1);
}
const db = createDb(loadDbConfig().DATABASE_URL);
const host = localSiteHost(adminUrl);
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
