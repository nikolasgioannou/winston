import { AppShell } from "../components/app-shell";
import type { PageFixtures } from "./fixtures";
import { ProfilePage, type ProfilePageProps } from "./profile-page";

const noop = () => undefined;

const profile = (props: Partial<ProfilePageProps>) => () => (
  <AppShell activePath="/profile" drawerOpen={false} onDrawerOpenChange={noop}>
    <ProfilePage
      email="ada@example.com"
      firstName="Ada"
      lastName="Lovelace"
      onSaveName={() => Promise.resolve({ ok: true, changed: [] })}
      onDeleteAccount={noop}
      {...props}
    />
  </AppShell>
);

/** The profile page's states for the dev design view. */
export const profileFixtures: PageFixtures = {
  title: "Profile",
  path: "/profile",
  states: {
    default: { label: "Default", render: profile({}) },
    deleting: {
      label: "Delete confirmation",
      render: profile({ confirmingDelete: true }),
    },
  },
};
