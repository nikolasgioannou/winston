import { createFileRoute } from "@tanstack/react-router";
import { generateToken } from "@winston/shared/tokens";
import {
  connectCallbackPath,
  connectionToReconnect,
  isConnectionDomain,
} from "../../../../server/connect.server";
import { database } from "../../../../server/db.server";
import { googleConnectUrl } from "../../../../server/google.server";
import {
  currentUser,
  googleClient,
  setConnectCookies,
} from "../../../../server/session.server";

// Begins connecting a Google account for ?domain=mail|calendar, or
// reconnecting one with ?reconnect=<acct_id>: remembers the state, the PKCE verifier
// and the domain in short-lived cookies, then sends the browser to Google.
export const Route = createFileRoute("/auth/google/connect/")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const redirect = (location: string) =>
          new Response(null, { status: 302, headers: { Location: location } });
        const user = await currentUser();
        if (!user) return redirect("/");
        const params = new URL(request.url).searchParams;
        const reconnecting = await connectionToReconnect(
          database(),
          user.id,
          params.get("reconnect"),
        );
        const domain = reconnecting?.domain ?? params.get("domain");
        if (!isConnectionDomain(domain)) return redirect("/accounts");
        const state = generateToken();
        const codeVerifier = generateToken();
        setConnectCookies({ state, codeVerifier, domain });
        return redirect(
          googleConnectUrl(googleClient(connectCallbackPath), {
            state,
            codeVerifier,
            domain,
            loginHint: reconnecting?.externalEmail,
          }),
        );
      },
    },
  },
});
