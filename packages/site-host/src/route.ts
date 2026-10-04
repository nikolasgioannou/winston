/**
 * What the dispatch Worker knows about a site (docs/design.md §9a): one
 * entry per name in the routes map (Workers KV in production), written by
 * the backend whenever a site changes.
 */
export interface SiteRoute {
  /** The site's Worker in the dispatch namespace. */
  script: string;
  /** The user who owns it, and so may open it while it's private. */
  ownerId: string;
  access: "private";
  /** Over a cap or switched off: visitors get the "paused" page. */
  paused: boolean;
}

/**
 * The site name a hostname addresses under `domain` (`blog` in
 * `blog.runwinston.app`), or null for the domain itself, deeper names and
 * other hosts.
 */
export function siteNameOf(hostname: string, domain: string): string | null {
  const host = hostname.toLowerCase();
  const suffix = `.${domain.toLowerCase()}`;
  if (!host.endsWith(suffix)) return null;
  const name = host.slice(0, -suffix.length);
  return name && !name.includes(".") ? name : null;
}

/** A site's address: `https://runwinston.app` and `blog` → `https://blog.runwinston.app`. */
export function siteUrl(sitesUrl: string, name: string) {
  const url = new URL(sitesUrl);
  url.hostname = `${name}.${url.hostname}`;
  return url.origin;
}

/** Whether a name can be a site's (one DNS label, lowercase). */
export const isSiteName = (name: string) =>
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name);

/** Names kept back: ours, and ones that pass for a service's own address. */
const reservedNames = new Set([
  "admin",
  "api",
  "app",
  "auth",
  "dev",
  "docs",
  "email",
  "gateway",
  "help",
  "login",
  "mail",
  "runwinston",
  "signin",
  "sites",
  "staging",
  "status",
  "support",
  "winston",
  "www",
]);

/** Why a name can't be claimed for a new site, or null when it can (taken names aside). */
export function siteNameProblem(name: string): string | null {
  if (!isSiteName(name))
    return `"${name}" can't be a site's name: use lowercase letters, digits and hyphens (not at the ends), up to 63.`;
  if (name.length < 3) return "Site names have at least 3 characters.";
  if (reservedNames.has(name) || name.startsWith("xn--"))
    return `"${name}" is reserved.`;
  return null;
}

/** Narrows a stored route, so a malformed entry reads as no site. */
export function parseSiteRoute(value: unknown): SiteRoute | null {
  if (typeof value !== "object" || value === null) return null;
  const route = value as Record<string, unknown>;
  return typeof route.script === "string" &&
    typeof route.ownerId === "string" &&
    route.access === "private" &&
    typeof route.paused === "boolean"
    ? {
        script: route.script,
        ownerId: route.ownerId,
        access: route.access,
        paused: route.paused,
      }
    : null;
}
