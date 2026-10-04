/**
 * Where to send someone after they sign in, when a link brought them to the
 * site signed out: only into the connect flow (`/auth/google/connect?…`,
 * which checks its own query), the browser page (`/browser?window=…`) or
 * opening a private site (`/sites/open?…`, docs/design.md §9a), so `next`
 * can never send the browser anywhere else.
 */
const allowed = new Set(["/auth/google/connect", "/browser", "/sites/open"]);

export function returnPath(next: string | null | undefined) {
  if (!next) return undefined;
  const base = "https://site.invalid";
  let url: URL;
  try {
    url = new URL(next, base);
  } catch {
    return undefined;
  }
  if (url.origin !== base || !allowed.has(url.pathname)) return undefined;
  return `${url.pathname}${url.search}`;
}
