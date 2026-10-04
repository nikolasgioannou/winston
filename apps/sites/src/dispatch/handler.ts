import {
  parseSiteRoute,
  siteNameOf,
  type SiteRoute,
} from "@winston/site-host/route";
import { failedPage, noSitePage, pausedPage, privatePage } from "./pages.ts";

/**
 * Per-request limits on a site's Worker (Workers for Platforms custom
 * limits). Going over throws inside the site, which reads as a failure.
 * Not enforced by the local host.
 */
export const siteLimits = { cpuMs: 50, subRequests: 50 };

export interface DispatchDeps {
  /** The sites' domain: `runwinston.app`, or `sites.localhost` locally. */
  domain: string;
  /** The routes map's raw entry for a name (Workers KV). */
  route(name: string): Promise<unknown>;
  /** Calls a site's Worker, or returns null when no such Worker exists. */
  site(
    script: string,
    request: Request,
    limits: typeof siteLimits,
  ): Promise<Response> | null;
  /** Whether this request may open this site. */
  admit(request: Request, route: SiteRoute): Promise<boolean>;
}

/**
 * Routes a request on `<name>.<domain>` to that site's Worker
 * (docs/design.md §9a), or answers with one of the pages: no site, paused,
 * private, or failed.
 */
export async function dispatch(
  request: Request,
  deps: DispatchDeps,
): Promise<Response> {
  const name = siteNameOf(new URL(request.url).hostname, deps.domain);
  if (!name) return noSitePage();
  const route = parseSiteRoute(await deps.route(name));
  if (!route) return noSitePage();
  if (route.paused) return pausedPage();
  if (!(await deps.admit(request, route))) return privatePage();
  try {
    return (await deps.site(route.script, request, siteLimits)) ?? noSitePage();
  } catch {
    return failedPage();
  }
}

/** Until owners can sign in (901702), no request may open a private site. */
export const admitNobody = () => Promise.resolve(false);
