import { createFileRoute } from "@tanstack/react-router";
import { rampConnectUrl } from "@winston/connectors/ramp-auth";
import { connectPaths } from "@winston/domain/connections";
import { generateToken } from "@winston/shared/tokens";
import {
  connectionToReconnect,
  rampConnectCallbackPath,
} from "../../../../server/connect.server";
import { database } from "../../../../server/db.server";
import {
  currentUser,
  rampClient,
  setConnectCookies,
} from "../../../../server/session.server";

// Begins connecting a Ramp account (?domain=ramp), or reconnecting one with
// ?reconnect=<acct_id>: remembers the state and the PKCE verifier in
// short-lived cookies, then sends the browser to Ramp (8f6c44).
export const Route = createFileRoute("/auth/ramp/connect/")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const redirect = (location: string) =>
          new Response(null, { status: 302, headers: { Location: location } });
        const url = new URL(request.url);
        const user = await currentUser();
        // Signed out (a link from Winston, say): sign in, then come back here.
        if (!user)
          return redirect(
            `/?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`,
          );
        const params = url.searchParams;
        const reconnecting = await connectionToReconnect(
          database(),
          user.id,
          params.get("reconnect"),
        );
        if ((reconnecting?.domain ?? params.get("domain")) !== "ramp")
          return redirect("/accounts");
        const client = rampClient(rampConnectCallbackPath);
        if (!client) return redirect("/accounts?error=unavailable");
        const state = generateToken();
        const codeVerifier = generateToken();
        setConnectCookies(connectPaths.ramp, {
          state,
          codeVerifier,
          domain: "ramp",
        });
        return redirect(rampConnectUrl(client, { state, codeVerifier }));
      },
    },
  },
});
