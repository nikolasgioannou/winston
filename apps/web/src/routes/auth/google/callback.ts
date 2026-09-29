import { createFileRoute } from "@tanstack/react-router";
import { database } from "../../../server/db.server";
import { completeGoogleSignIn } from "../../../server/sign-in.server";
import {
  googleClient,
  setSessionCookie,
  takeFlowCookies,
} from "../../../server/session.server";

// Where Google sends the browser back (the dev client's redirect URI).
export const Route = createFileRoute("/auth/google/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const result = await completeGoogleSignIn(
          { db: database(), google: googleClient() },
          new URL(request.url).searchParams,
          takeFlowCookies(),
        );
        if ("sessionToken" in result) setSessionCookie(result.sessionToken);
        return new Response(null, {
          status: 302,
          headers: { Location: result.redirectTo },
        });
      },
    },
  },
});
