import { createFileRoute, redirect } from "@tanstack/react-router";

// Links from before the signed-in browser page (b8e28a): the page now shows
// every window, so an old link lands there (through sign-in, if needed).
export const Route = createFileRoute("/t/$token")({
  beforeLoad: () => {
    throw redirect({ to: "/browser", search: {} });
  },
});
