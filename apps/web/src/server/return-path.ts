/**
 * Where to send someone after they sign in, when a link brought them to the
 * site signed out: only into the connect flow (`/auth/google/connect?…`,
 * which checks its own query), so `next` can never send the browser anywhere
 * else.
 */
export function returnPath(next: string | null | undefined) {
  if (!next) return undefined;
  const base = "https://site.invalid";
  let url: URL;
  try {
    url = new URL(next, base);
  } catch {
    return undefined;
  }
  if (url.origin !== base || url.pathname !== "/auth/google/connect")
    return undefined;
  return `${url.pathname}${url.search}`;
}
