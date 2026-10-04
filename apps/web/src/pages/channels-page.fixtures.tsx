import { AppShell } from "../components/app-shell";
import { ChannelsPage, type ChannelsPageProps } from "./channels-page";
import type { PageFixtures } from "./fixtures";
import { fixtureTelegramLink } from "./home-page.fixtures";

const noop = () => undefined;

const linked = {
  username: "ada_l",
  displayName: "Ada Lovelace",
  linkedAt: "2026-09-29T12:00:00.000Z",
};

const channels = (props: Partial<ChannelsPageProps>) => () => (
  <AppShell activePath="/channels" drawerOpen={false} onDrawerOpenChange={noop}>
    <ChannelsPage
      telegram={null}
      telegramLink={fixtureTelegramLink}
      connecting={false}
      onConnectingChange={noop}
      onDisconnectTelegram={noop}
      {...props}
    />
  </AppShell>
);

/** The channels page's states for the dev design view. */
export const channelsFixtures: PageFixtures = {
  title: "Channels",
  path: "/channels",
  states: {
    linked: { label: "Default", render: channels({ telegram: linked }) },
    not_linked: { label: "Telegram not linked", render: channels({}) },
    connecting: {
      label: "Connecting Telegram",
      render: channels({ connecting: true }),
    },
    issuing: {
      label: "Telegram link loading",
      render: channels({ connecting: true, telegramLink: null }),
    },
    no_username: {
      label: "Linked, no username",
      render: channels({ telegram: { ...linked, username: null } }),
    },
    no_name: {
      label: "Linked, name not known yet",
      render: channels({
        telegram: { ...linked, username: null, displayName: null },
      }),
    },
    changing: {
      label: "Changing account",
      render: channels({ telegram: linked, connecting: true }),
    },
    disconnecting: {
      label: "Disconnect Telegram confirmation",
      render: channels({
        telegram: linked,
        confirmingTelegramDisconnect: true,
      }),
    },
  },
};
