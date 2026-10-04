import {
  parseSiteRoute,
  sharePath,
  siteNameOf,
} from "@winston/site-host/route";
import {
  enter,
  enterPath,
  hasShareKey,
  openShareLink,
  passFor,
  signInFor,
  withoutAccessCookies,
  withSafeCookies,
  type AccessDeps,
} from "./access.ts";
import { failedPage, noSitePage, pausedPage, privatePage } from "./pages.ts";

/**
 * Per-request limits on a site's Worker (Workers for Platforms custom
 * limits). Going over throws inside the site, which reads as a failure.
 * Not enforced by the local host.
 */
export const siteLimits = { cpuMs: 50, subRequests: 50 };

export interface DispatchDeps extends AccessDeps {
  /** The sites' domain: `runwinston.app`, or `sites.localhost` locally. */
  domain: string;
  /** The routes map's raw entry for a name (Workers KV). */
  route(name: string): Promise<unknown>;
  /** Calls a site's Worker, or returns null when no such Worker exists. */
  site(
    script: string,
    request: Request,
    limits: typeof siteLimits,
  ): Promise<Response | null> | null;
}

/**
 * Routes a request on `<name>.<domain>` to that site's Worker
 * (docs/design.md §9a) when the browser holds its owner's pass or its
 * share key, or answers
 * with one of the pages: no site, paused, private, or failed.
 */
export async function dispatch(
  request: Request,
  deps: DispatchDeps,
): Promise<Response> {
  const url = new URL(request.url);
  const name = siteNameOf(url.hostname, deps.domain);
  if (!name) return noSitePage();
  const route = parseSiteRoute(await deps.route(name));
  if (!route) return noSitePage();
  if (route.paused) return pausedPage();
  if (url.pathname === enterPath)
    return enter(request, name, route.ownerId, deps.passKey);
  if (url.pathname === sharePath) return openShareLink(request, route);
  if (!(await hasShareKey(request, route))) {
    const pass = await passFor(request, name, deps.passKey);
    if (!pass) return signInFor(request, name, deps);
    // Someone else's pass: signing in again wouldn't change anything.
    if (pass.sub !== route.ownerId) return privatePage();
  }
  try {
    const response = await deps.site(
      route.script,
      withoutAccessCookies(request),
      siteLimits,
    );
    return response ? withSafeCookies(response) : noSitePage();
  } catch {
    return failedPage();
  }
}
