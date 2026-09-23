import { QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { SignIn } from "../auth/sign-in";
import { Connections } from "../connections/connections";
import { TelegramPairing } from "../telegram/pairing";
import { DownloadPage } from "../files/download";
import { HandoffPage } from "../handoffs/handoff";
import { ManagementShell } from "./shell";
import { AccountView } from "./account-view";
import { queryClient } from "./query-client";
import { Schedules } from "../schedules/schedules";
import { clearPendingDestination, restoreManagementPage } from "./locator";

const rootRoute = createRootRouteWithContext<{ signOut: () => void }>()({
  component: Layout,
  notFoundComponent: () => <h1 className="text-xl font-medium">Page not found</h1>,
});

function Layout() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const navigate = useNavigate();
  return (
    <ManagementShell
      activeHref={pathname}
      onNavigate={(href) => {
        clearPendingDestination();
        navigate({
          to: href === "/schedules" ? "/schedules" : href === "/connections" ? "/connections" : "/",
        }).catch(() => {
          window.location.assign(href);
        });
      }}
    >
      <Outlet />
    </ManagementShell>
  );
}

const accountRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: AccountPage,
});

function AccountPage() {
  const { signOut } = rootRoute.useRouteContext();
  return (
    <AccountView onSignOut={signOut}>
      <TelegramPairing />
    </AccountView>
  );
}

const connectionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/connections",
  component: () => (
    <>
      <h1 className="text-xl font-medium">Connections</h1>
      <Connections />
    </>
  ),
});
const downloadRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/files/$id",
  component: DownloadRoute,
});
const schedulesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/schedules",
  component: Schedules,
});
function DownloadRoute() {
  return <DownloadPage id={downloadRoute.useParams().id} />;
}
const handoffRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/handoffs/$id",
  component: HandoffRoute,
});
function HandoffRoute() {
  return <HandoffPage id={handoffRoute.useParams().id} />;
}

restoreManagementPage();
const router = createRouter({
  routeTree: rootRoute.addChildren([
    accountRoute,
    connectionsRoute,
    schedulesRoute,
    downloadRoute,
    handoffRoute,
  ]),
  context: { signOut: () => {} },
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

export function ManagementApp() {
  return (
    <QueryClientProvider client={queryClient}>
      <SignIn
        renderAuthenticated={(signOut) => <RouterProvider router={router} context={{ signOut }} />}
      />
    </QueryClientProvider>
  );
}
