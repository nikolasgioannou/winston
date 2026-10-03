/**
 * The local OAuth relay (docs/local-dev.md, Worktrees). Google redirects only
 * to the dev client's registered URIs, so a worktree's site sends Google here
 * instead and leaves a cookie naming its own origin. Cookies ignore ports, so
 * the cookie arrives here too, and the relay sends the browser on to the same
 * callback on that origin. docker-compose.yml runs it on port 3003.
 */

/** Set by the site (apps/web/src/server/session.server.ts). */
export const returnCookieName = "winston_oauth_return";

const localOrigin = /^http:\/\/localhost:\d{1,5}$/;

export function relay(request: Request): Response {
  const url = new URL(request.url);
  const origin = new Bun.CookieMap(request.headers.get("cookie") ?? "").get(
    returnCookieName,
  );
  // Only Google's callbacks, and only back to a local site: never an open redirect.
  if (!url.pathname.startsWith("/auth/google/") || !origin?.match(localOrigin))
    return new Response(
      "Nothing to relay. Sign in from a worktree's site to come through here.\n",
      { status: 400 },
    );
  return new Response(null, {
    status: 302,
    headers: { Location: `${origin}${url.pathname}${url.search}` },
  });
}

if (import.meta.main) {
  Bun.serve({ hostname: "0.0.0.0", port: 3003, fetch: relay });
  console.log("OAuth relay listening on port 3003");
}
