import { AppShell } from "../components/app-shell";
import type { PageFixtures } from "./fixtures";
import { fixtureTelegramLink } from "./home-page.fixtures";
import { ProfilePage, type ProfilePageProps } from "./profile-page";

const noop = () => undefined;

const linked = { username: "ada_l", linkedAt: "2026-09-29T12:00:00.000Z" };

const profile = (props: Partial<ProfilePageProps>) => () => (
  <AppShell activePath="/profile" drawerOpen={false} onDrawerOpenChange={noop}>
    <ProfilePage
      email="ada@example.com"
      firstName="Ada"
      lastName="Lovelace"
      timezone="Europe/London"
      onSaveName={() => Promise.resolve({ ok: true, changed: [] })}
      onTimezoneChange={noop}
      onDeleteAccount={noop}
      telegram={null}
      telegramLink={fixtureTelegramLink}
      relinking={false}
      onRelinkingChange={noop}
      {...props}
    />
  </AppShell>
);

/** The profile page's states for the dev design view. */
export const profileFixtures: PageFixtures = {
  title: "Profile",
  path: "/profile",
  states: {
    linked: { label: "Default", render: profile({ telegram: linked }) },
    not_linked: { label: "Telegram not linked", render: profile({}) },
    issuing: {
      label: "Telegram link loading",
      render: profile({ telegramLink: null }),
    },
    no_username: {
      label: "Linked, no username",
      render: profile({ telegram: { ...linked, username: null } }),
    },
    deleting: {
      label: "Delete confirmation",
      render: profile({ telegram: linked, confirmingDelete: true }),
    },
    relinking: {
      label: "Linking another account",
      render: profile({ telegram: linked, relinking: true }),
    },
  },
};
