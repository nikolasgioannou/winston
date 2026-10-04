/**
 * The `switch_sites` job (docs/design.md §9a): the sites kill switch, queued
 * by `bun run prod sites pause-all|resume-all` and run here, where the site
 * host is.
 */
import type { SiteHost } from "@winston/site-host/host";
import { pauseAllSites, resumeAllSites } from "@winston/site-host/usage";
import { z } from "zod";
import type { JobHandler } from "../worker.ts";

const payload = z.object({ action: z.enum(["pause-all", "resume-all"]) });

export function switchSitesHandler(host: SiteHost): JobHandler {
  return async ({ job, db, logger }) => {
    const { action } = payload.parse(job.payload);
    const count =
      action === "pause-all"
        ? await pauseAllSites(db, host)
        : await resumeAllSites(db, host);
    logger.info({ action, sites: count }, "sites switched");
  };
}
