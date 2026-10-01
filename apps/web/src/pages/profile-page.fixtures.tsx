import { AppShell } from "../components/app-shell";
import type { PageFixtures } from "./fixtures";
import { fixtureTelegramLink } from "./home-page.fixtures";
import { ProfilePage, type ProfilePageProps } from "./profile-page";

const noop = () => undefined;

const linked = {
  username: "ada_l",
  displayName: "Ada Lovelace",
  linkedAt: "2026-09-29T12:00:00.000Z",
};

const profile = (props: Partial<ProfilePageProps>) => () => (
  <AppShell activePath="/profile" drawerOpen={false} onDrawerOpenChange={noop}>
    <ProfilePage
      email="ada@example.com"
      firstName="Ada"
      lastName="Lovelace"
      onSaveName={() => Promise.resolve({ ok: true, changed: [] })}
      onDeleteAccount={noop}
      telegram={null}
      telegramLink={fixtureTelegramLink}
      connecting={false}
      onConnectingChange={noop}
      onDisconnectTelegram={noop}
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
    connecting: {
      label: "Connecting Telegram",
      render: profile({ connecting: true }),
    },
    issuing: {
      label: "Telegram link loading",
      render: profile({ connecting: true, telegramLink: null }),
    },
    no_username: {
      label: "Linked, no username",
      render: profile({ telegram: { ...linked, username: null } }),
    },
    no_name: {
      label: "Linked, name not known yet",
      render: profile({
        telegram: { ...linked, username: null, displayName: null },
      }),
    },
    deleting: {
      label: "Delete confirmation",
      render: profile({ telegram: linked, confirmingDelete: true }),
    },
    changing: {
      label: "Changing account",
      render: profile({ telegram: linked, connecting: true }),
    },
    disconnecting: {
      label: "Disconnect Telegram confirmation",
      render: profile({ telegram: linked, confirmingTelegramDisconnect: true }),
    },
  },
};
