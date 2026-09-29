import type { PageFixtures } from "../pages/fixtures";
import { AppShell, type AppShellProps } from "./app-shell";
import { PlaceholderPage } from "./placeholder-page";

const noop = () => undefined;

function Shell(props: Partial<AppShellProps>) {
  return (
    <AppShell
      activePath="/accounts"
      drawerOpen={false}
      onDrawerOpenChange={noop}
      {...props}
    >
      <PlaceholderPage title="Connected accounts" />
    </AppShell>
  );
}

/** The app shell's states for the dev design view; pick the Mobile frame for the drawer. */
export const appShellFixtures: PageFixtures = {
  title: "App shell",
  path: "/home (and every signed-in page)",
  states: {
    default: { label: "Default", render: () => <Shell /> },
    drawer_open: {
      label: "Drawer open (mobile)",
      render: () => <Shell drawerOpen />,
    },
  },
};
