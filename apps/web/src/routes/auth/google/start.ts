import { createFileRoute } from "@tanstack/react-router";
import { generateToken } from "@winston/shared/tokens";
import { googleAuthorizationUrl } from "../../../server/google.server";
import { googleClient, setFlowCookies } from "../../../server/session.server";

// Begins signing in with Google: remembers the state, the PKCE verifier and
// the browser's time zone in short-lived cookies, then sends the browser on.
export const Route = createFileRoute("/auth/google/start")({
  server: {
    handlers: {
      GET: ({ request }) => {
        const state = generateToken();
        const codeVerifier = generateToken();
        const timezone =
          new URL(request.url).searchParams.get("tz") ?? undefined;
        setFlowCookies({ state, codeVerifier, timezone });
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
