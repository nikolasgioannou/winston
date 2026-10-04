import { z } from "zod";
import { cloudflareSiteHost } from "./cloudflare-host.ts";
import type { SiteHost } from "./host.ts";
import { localSiteHost } from "./local-host.ts";

/**
 * Where a service's sites run (docs/design.md §9a): Cloudflare in production
 * (the account, the dispatch namespace, the routes map's KV namespace and the
 * backend's token), the dev stack's sites service locally.
 */
export const siteHostConfigSchema = z.object({
  CLOUDFLARE_API_TOKEN: z.string().min(1).optional(),
  CLOUDFLARE_ACCOUNT_ID: z.string().min(1).optional(),
  CLOUDFLARE_DISPATCH_NAMESPACE: z.string().min(1).optional(),
  CLOUDFLARE_ROUTES_KV_ID: z.string().min(1).optional(),
  /** The local site host's admin API (`bun dev`'s sites service). */
  SITES_ADMIN_URL: z.url().optional(),
});

export type SiteHostConfig = z.output<typeof siteHostConfigSchema>;

/** The host the config names, or none (deploying sites is then unavailable). */
export function siteHostFrom(config: SiteHostConfig): SiteHost | undefined {
  const {
    CLOUDFLARE_API_TOKEN: apiToken,
    CLOUDFLARE_ACCOUNT_ID: accountId,
    CLOUDFLARE_DISPATCH_NAMESPACE: namespace,
    CLOUDFLARE_ROUTES_KV_ID: routesKvId,
  } = config;
  if (apiToken && accountId && namespace && routesKvId)
    return cloudflareSiteHost({ apiToken, accountId, namespace, routesKvId });
  return config.SITES_ADMIN_URL
    ? localSiteHost(config.SITES_ADMIN_URL)
    : undefined;
}
