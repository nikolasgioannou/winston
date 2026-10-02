import { createFileRoute } from "@tanstack/react-router";
import { generateToken } from "@winston/shared/tokens";
import { googleAuthorizationUrl } from "../../../server/google.server";
import { returnPath } from "../../../server/return-path";
import { googleClient, setFlowCookies } from "../../../server/session.server";

// Begins signing in with Google: remembers the state, the PKCE verifier and
// the browser's time zone (and where to return, if a link brought them) in
// short-lived cookies, then sends the browser on.
export const Route = createFileRoute("/auth/google/start")({
  server: {
    handlers: {
      GET: ({ request }) => {
        const state = generateToken();
        const codeVerifier = generateToken();
        const params = new URL(request.url).searchParams;
        const timezone = params.get("tz") ?? undefined;
        const next = returnPath(params.get("next"));
        setFlowCookies({ state, codeVerifier, timezone, next });
        return new Response(null, {
          status: 302,
          headers: {
            Location: googleAuthorizationUrl(googleClient(), {
              state,
              codeVerifier,
            }),
          },
        });
      },
    },
  },
});
