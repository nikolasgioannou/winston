import { createFileRoute } from "@tanstack/react-router";
import { webConfig } from "../../server/config.server";
import { currentUser } from "../../server/session.server";
import { sitePassRedirect } from "../../server/sites.server";

const go = (location: string) =>
  new Response(null, {
    status: 303,
    headers: {
      Location: location,
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    },
  });

// Where a private site sends a browser without a pass (docs/design.md §9a):
// signed out, it signs in first and comes back here; signed in, it goes
// back to the site with a pass.
export const Route = createFileRoute("/sites/open")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const user = await currentUser();
        if (!user)
          return go(
            `/?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`,
          );
        const { SITES_PASS_KEY, SITES_PUBLIC_URL } = webConfig();
        const location = SITES_PASS_KEY
          ? sitePassRedirect({
              userId: user.id,
              query: url.searchParams,
              passKey: SITES_PASS_KEY,
              sitesUrl: SITES_PUBLIC_URL,
            })
          : undefined;
        return location ? go(location) : go("/home");
      },
    },
  },
});
