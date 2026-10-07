import { createFileRoute } from "@tanstack/react-router";
import { connectPaths } from "@winston/domain/connections";
import {
  completeRampConnect,
  rampConnectCallbackPath,
} from "../../../../server/connect.server";
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
