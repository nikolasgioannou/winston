import { QueryClientProvider } from "@tanstack/react-query";
import { lazy, Suspense } from "react";
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
import { Responsibilities } from "../responsibilities/responsibilities";
const ScheduleEditor = lazy(async () => ({
  default: (await import("../schedules/editor")).ScheduleEditor,
}));
const Computers = lazy(async () => ({
  default: (await import("../computers/computers")).Computers,
}));
const ScheduleRuns = lazy(async () => ({
  default: (await import("../schedules/runs")).ScheduleRuns,
}));
const ResponsibilityDetail = lazy(async () => ({
  default: (await import("../responsibilities/detail")).ResponsibilityDetail,
}));
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
      activeHref={
        pathname.startsWith("/responsibilities/")
          ? "/responsibilities"
          : pathname.startsWith("/schedules/")
            ? "/schedules"
            : pathname
      }
      onNavigate={(href) => {
        clearPendingDestination();
        navigate({
          to:
            href === "/computers"
              ? "/computers"
              : href === "/responsibilities"
                ? "/responsibilities"
                : href === "/schedules"
                  ? "/schedules"
                  : href === "/connections"
                    ? "/connections"
                    : "/",
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
const computersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/computers",
  component: () => (
    <Suspense fallback={<p role="status">Loading computers…</p>}>
      <Computers />
    </Suspense>
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
const responsibilitiesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/responsibilities",
  component: Responsibilities,
});
const responsibilityDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/responsibilities/$id",
  component: ResponsibilityDetailRoute,
});
function ResponsibilityDetailRoute() {
  const { id } = responsibilityDetailRoute.useParams();
  const navigate = useNavigate();
  return (
    <Suspense fallback={<p role="status">Loading responsibility…</p>}>
      <ResponsibilityDetail
        key={id}
        id={id}
        onBack={() => {
          navigate({ to: "/responsibilities" }).catch(() => {
            window.location.assign("/responsibilities");
          });
        }}
      />
    </Suspense>
  );
}
const editorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/schedules/$id",
  component: EditorRoute,
});
function EditorRoute() {
  const { id } = editorRoute.useParams();
  const navigate = useNavigate();
  return (
    <Suspense fallback={<p role="status">Loading schedule…</p>}>
      <ScheduleEditor
        id={id}
        onBack={() => {
          navigate({ to: "/schedules" }).catch(() => {
            window.location.assign("/schedules");
          });
        }}
      />
    </Suspense>
  );
}
const runsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/schedules/$id/runs",
  component: RunsRoute,
});
function RunsRoute() {
  const { id } = runsRoute.useParams();
  const navigate = useNavigate();
  return (
    <Suspense fallback={<p role="status">Loading schedule…</p>}>
      <ScheduleRuns
        key={id}
        id={id}
        onBack={() => {
          navigate({ to: "/schedules" }).catch(() => {
            window.location.assign("/schedules");
          });
        }}
      />
    </Suspense>
  );
}
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
    computersRoute,
    schedulesRoute,
    responsibilitiesRoute,
    responsibilityDetailRoute,
    editorRoute,
    runsRoute,
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
