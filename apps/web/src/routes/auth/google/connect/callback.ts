import { createFileRoute } from "@tanstack/react-router";
import {
  completeGoogleConnect,
  connectCallbackPath,
} from "../../../../server/connect.server";
import { database } from "../../../../server/db.server";
import {
  currentUser,
  googleClient,
  takeConnectCookies,
} from "../../../../server/session.server";
import { tokenVault } from "../../../../server/vault.server";

// Where Google sends the browser back after connecting an account. Only the
// signed-in user who started the flow can finish it.
export const Route = createFileRoute("/auth/google/connect/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const cookies = takeConnectCookies();
        const user = await currentUser();
        const result = user
          ? await completeGoogleConnect(
              {
                db: database(),
                google: googleClient(connectCallbackPath),
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
