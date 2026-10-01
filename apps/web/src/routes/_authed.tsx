import {
  createFileRoute,
  Outlet,
  redirect,
  useLocation,
  useRouter,
} from "@tanstack/react-router";
import { toast } from "@winston/ui";
import { useEffect, useRef, useState } from "react";
import { AppShell } from "../components/app-shell";
import { saveSidebarWidth } from "../components/sidebar-width";
import { syncBrowserTimezone } from "../server/profile-functions";
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
  const { user, sidebarWidth } = Route.useRouteContext();
  useFollowBrowserTimezone(user.browserTimezone);
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

/**
 * Once per app load, reports the browser's time zone when it isn't the one
 * last reported. The server adopts it then (someone who travels keeps getting
 * local times), but a zone Winston set stays until the device moves, and a
 * quiet notice says when it changed (docs/design.md §20).
 */
function useFollowBrowserTimezone(lastReported: string | null) {
  const router = useRouter();
  const checked = useRef(false);
  useEffect(() => {
    if (checked.current) return;
    checked.current = true;
    const browser = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (browser === lastReported) return;
    void syncBrowserTimezone({ data: { timezone: browser } })
      .then(({ updated }) => {
        if (!updated) return;
        void router.invalidate();
        toast(`Time zone updated to ${browser.replaceAll("_", " ")}`, {
          description: "It follows this device.",
        });
      })
      .catch(() => undefined);
  }, [lastReported, router]);
}
