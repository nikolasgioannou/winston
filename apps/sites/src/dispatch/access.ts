import {
  sitePassMs,
  verifySitePass,
  type SitePass,
} from "@winston/site-host/pass";
import type { SiteRoute } from "@winston/site-host/route";
import { expiredLinkPage, privatePage } from "./pages.ts";

/**
 * Who may open a site (docs/design.md §9a, "Owner access", "Sharing"): its
 * owner, with a pass for this site issued to them. Without one, a page load
 * goes to `runwinston.com` to get one, carrying a nonce this site keeps in a
 * cookie, so a pass that leaks from the URL is useless in another browser.
 * While a site is shared by link, also anyone holding its current share key.
 */

/** The path the site sends a browser back to with its pass. Reserved on every site. */
export const enterPath = "/__winston/enter";

const nonceMs = 10 * 60 * 1000;
const shareMs = 30 * 24 * 60 * 60 * 1000;

/** Over https the cookies are `__Host-` (host-only, Secure); dev sites are plain http. */
const cookieNames = (url: URL) => {
  const prefix = url.protocol === "https:" ? "__Host-" : "";
  return {
    pass: `${prefix}winston_site_pass`,
    nonce: `${prefix}winston_site_nonce`,
    share: `${prefix}winston_site_share`,
  };
};

/** SHA-256 in hex: share keys are compared by hash, as the route holds only that. */
async function hashKey(key: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(key),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Whether `key` is the site's current share key (and it's shared by link at all). */
async function opensShared(key: string | null | undefined, route: SiteRoute) {
  return (
    route.access === "link" &&
    route.shareKeyHash !== null &&
    Boolean(key) &&
    (await hashKey(key ?? "")) === route.shareKeyHash
  );
}

/** Whether this browser holds the site's current share key. */
export const hasShareKey = (request: Request, route: SiteRoute) =>
  opensShared(
    cookies(request).get(cookieNames(new URL(request.url)).share),
    route,
  );

/**
 * Opening the share link: the key goes in a cookie and the browser on to the
 * site, without the key in the address. An old or wrong key gets a page
 * saying the link doesn't work any more.
 */
export async function openShareLink(request: Request, route: SiteRoute) {
  const url = new URL(request.url);
  const key = url.searchParams.get("key");
  if (!key || !(await opensShared(key, route))) return expiredLinkPage();
  return redirect("/", [setCookie(url, cookieNames(url).share, key, shareMs)]);
}

const setCookie = (url: URL, name: string, value: string, maxAgeMs: number) =>
  [
    `${name}=${value}`,
    "Path=/",
    `Max-Age=${String(Math.floor(maxAgeMs / 1000))}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(url.protocol === "https:" ? ["Secure"] : []),
  ].join("; ");

function cookies(request: Request) {
  const jar = new Map<string, string>();
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0) jar.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
  }
  return jar;
}

/** A path on this site to go on to: only a local one, never `//elsewhere`. */
function localPath(path: string | null) {
  return path?.startsWith("/") &&
    !path.startsWith("//") &&
    !path.startsWith("/\\")
    ? path
    : "/";
}

const redirect = (location: string, setCookies: string[] = []) => {
  const headers = new Headers({
    location,
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });
  for (const cookie of setCookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 303, headers });
};

export interface AccessDeps {
  /** The site's address, for sign-in: https://runwinston.com. */
  webUrl: string;
  passKey: CryptoKey;
}

/** The browser's valid pass for this site, if it has one. */
export async function passFor(request: Request, name: string, key: CryptoKey) {
  const token = cookies(request).get(cookieNames(new URL(request.url)).pass);
  const pass = token ? await verifySitePass(token, key) : null;
  return pass?.site === name ? pass : null;
}

/**
 * The request as the site's Worker sees it: without the pass and nonce
 * cookies, which are the dispatch Worker's alone.
 */
export function withoutAccessCookies(request: Request) {
  const names = cookieNames(new URL(request.url));
  const kept = [...cookies(request)]
    .filter(
      ([key]) =>
        key !== names.pass && key !== names.nonce && key !== names.share,
    )
    .map(([key, value]) => `${key}=${value}`);
  const headers = new Headers(request.headers);
  if (kept.length) headers.set("cookie", kept.join("; "));
  else headers.delete("cookie");
  return new Request(request, { headers });
}

/**
 * A browser with no pass: a page load goes to sign in (with a fresh nonce
 * cookie); anything else, which couldn't follow that, gets the private page.
 */
export function signInFor(request: Request, name: string, deps: AccessDeps) {
  if (request.method !== "GET" && request.method !== "HEAD")
    return privatePage();
  const url = new URL(request.url);
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const open = new URL("/sites/open", deps.webUrl);
  open.searchParams.set("site", name);
  open.searchParams.set("nonce", nonce);
  open.searchParams.set("path", `${url.pathname}${url.search}`);
  return redirect(open.toString(), [
    setCookie(url, cookieNames(url).nonce, nonce, nonceMs),
  ]);
}

/**
 * The browser coming back from sign-in with a pass: kept in a cookie when it
 * was issued for this site, this browser's nonce, and the site's owner.
 */
export async function enter(
  request: Request,
  name: string,
  ownerId: string,
  key: CryptoKey,
) {
  const url = new URL(request.url);
  const names = cookieNames(url);
  const token = url.searchParams.get("pass") ?? "";
  const pass: SitePass | null = await verifySitePass(token, key);
  const nonce = cookies(request).get(names.nonce);
  if (
    !nonce ||
    pass?.site !== name ||
    pass.nonce !== nonce ||
    pass.sub !== ownerId
  )
    return privatePage();
  return redirect(localPath(url.searchParams.get("path")), [
    setCookie(
      url,
      names.pass,
      token,
      Math.min(sitePassMs, pass.exp - Date.now()),
    ),
    setCookie(url, names.nonce, "", 0),
  ]);
}

/**
 * A site's response, minus cookies it mustn't set: any with a `Domain`
 * (which would reach `runwinston.app` and every other site under it, until
 * the domain is on the Public Suffix List), and any named like the dispatch
 * Worker's own, so a site can't replace its visitor's pass or share key.
 */
export function withSafeCookies(response: Response) {
  const cookies = response.headers.getSetCookie();
  const safe = cookies.filter((cookie) => {
    const [pair = "", ...attributes] = cookie.split(";");
    const name = pair.split("=")[0]?.trim() ?? "";
    return (
      !/^(__Host-)?winston_site_/.test(name) &&
      !attributes.some((attribute) => /^\s*domain\s*=/i.test(attribute))
    );
  });
  if (safe.length === cookies.length) return response;
  const headers = new Headers(response.headers);
  headers.delete("set-cookie");
  for (const cookie of safe) headers.append("set-cookie", cookie);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
