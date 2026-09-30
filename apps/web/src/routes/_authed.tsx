import {
  createFileRoute,
  Outlet,
  redirect,
  useLocation,
} from "@tanstack/react-router";
import { useState } from "react";
import { AppShell } from "../components/app-shell";
import { saveSidebarWidth } from "../components/sidebar-width";
import { getShellState } from "../server/session-functions";

// Every page under here needs a signed-in user (the rest go to sign in at /), and
// shares the app shell.
export const Route = createFileRoute("/_authed")({
  beforeLoad: async () => {
    const { user, sidebarWidth } = await getShellState();
    if (!user) throw redirect({ to: "/" });
    return { user, sidebarWidth };
  },
  component: AuthedLayout,
});

function AuthedLayout() {
  const { sidebarWidth } = Route.useRouteContext();
  const { pathname } = useLocation();
  // The phone drawer is open only on the page it was opened on, so any
  // navigation (a link, the back button, a redirect) closes it.
  const [drawerOpenOn, setDrawerOpenOn] = useState<string | null>(null);
  return (
    <AppShell
      activePath={pathname}
      {...(sidebarWidth !== undefined ? { sidebarWidth } : {})}
      onSidebarWidthChange={saveSidebarWidth}
      drawerOpen={drawerOpenOn === pathname}
      onDrawerOpenChange={(open) => {
        setDrawerOpenOn(open ? pathname : null);
      }}
    >
      <Outlet />
    </AppShell>
  );
}
