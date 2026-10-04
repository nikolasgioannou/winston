/**
 * The sites usage job (docs/design.md §9a): every hour, each deployed site's
 * requests and CPU time are counted and charged, and over a cap it pauses.
 */
import type { Db } from "@winston/db/client";
import type { Logger } from "@winston/shared/logger";
import type { SiteHost } from "@winston/site-host/host";
import { accrueSiteUsage, siteUsageEveryMs } from "@winston/site-host/usage";

export function startSiteUsageJob(db: Db, host: SiteHost, logger: Logger) {
  const sweep = () => {
    accrueSiteUsage(db, host).catch((error: unknown) => {
      logger.error({ err: error }, "counting sites' usage failed");
    });
  };
  const timer = setInterval(sweep, siteUsageEveryMs);
  sweep();
  return () => {
    clearInterval(timer);
  };
}
