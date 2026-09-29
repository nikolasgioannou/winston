import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { getSessionUser } from "../server/session-functions";

// Every page under here needs a signed-in user; the rest go to /signin.
export const Route = createFileRoute("/_authed")({
  beforeLoad: async () => {
    const user = await getSessionUser();
    if (!user) throw redirect({ to: "/signin" });
    return { user };
  },
  component: Outlet,
});
