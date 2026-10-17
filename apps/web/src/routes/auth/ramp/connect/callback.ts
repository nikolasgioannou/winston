import { createFileRoute } from "@tanstack/react-router";
import { connectPaths } from "@winston/domain/connections";
import {
  completeRampConnect,
  rampConnectCallbackPath,
} from "../../../../server/connect.server";
import { webConfig } from "../../../../server/config.server";
import { database } from "../../../../server/db.server";
import {
  currentUser,
  rampClient,
  takeConnectCookies,
} from "../../../../server/session.server";
import { tokenVault } from "../../../../server/vault.server";

// Where Ramp sends the browser back after connecting an account. Only the
// signed-in user who started the flow can finish it.
export const Route = createFileRoute("/auth/ramp/connect/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        // Locally Ramp comes back to 127.0.0.1 (RAMP_CALLBACK_URL); the
        // session and the flow's cookies are on the site's own address, so
        // finish there, with the same code and state.
        const url = new URL(request.url);
        const site = new URL(webConfig().WEB_PUBLIC_URL);
        if (url.host !== site.host)
          return new Response(null, {
            status: 302,
            headers: {
              Location: new URL(`${url.pathname}${url.search}`, site).href,
            },
          });
        const cookies = takeConnectCookies(connectPaths.ramp);
        const user = await currentUser();
        const result = user
          ? await completeRampConnect(
              {
                db: database(),
                ramp: rampClient(rampConnectCallbackPath),
                vault: tokenVault(),
              },
              user.id,
              new URL(request.url).searchParams,
              cookies,
            )
          : { redirectTo: "/" };
        return new Response(null, {
          status: 302,
          headers: { Location: result.redirectTo },
        });
      },
    },
  },
});
