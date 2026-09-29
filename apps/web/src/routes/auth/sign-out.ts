import { createFileRoute } from "@tanstack/react-router";
import { endSession } from "../../server/session.server";

// Signs out (a form POST, so a link or prefetch can't do it by accident).
export const Route = createFileRoute("/auth/sign-out")({
  server: {
    handlers: {
      POST: async () => {
        await endSession();
        return new Response(null, {
          status: 303,
          headers: { Location: "/signin" },
        });
      },
    },
  },
});
