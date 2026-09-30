import { AppShell } from "../components/app-shell";
import type { HomeState } from "../server/home-state";
import type { PageFixtures } from "./fixtures";
import { HomePage } from "./home-page";

const noop = () => undefined;

export const fixtureTelegramLink =
  "https://t.me/RunWinstonDevBot?start=Fixture_Token_For_The_Design_View_000000000";

const fresh: HomeState = {
  firstName: "Ada",
  computer: "setting_up",
  telegramLinked: false,
  accountsConnected: 0,
  attention: [],
};
const setUp: HomeState = {
  ...fresh,
  computer: "ready",
  telegramLinked: true,
  accountsConnected: 2,
};

const home =
  (state: HomeState, retrying = false) =>
  () => (
    <AppShell activePath="/home" drawerOpen={false} onDrawerOpenChange={noop}>
      <HomePage
        state={state}
        telegramLink={state.telegramLinked ? null : fixtureTelegramLink}
        retrying={retrying}
        onRetry={noop}
      />
    </AppShell>
  );

/** The home page's states for the dev design view. */
export const homeFixtures: PageFixtures = {
  title: "Home",
  path: "/home",
  states: {
    fresh: { label: "Fresh user (provisioning)", render: home(fresh) },
    failed: {
      label: "Provisioning failed",
      render: home({ ...fresh, computer: "failed" }),
    },
    retrying: {
      label: "Provisioning failed, retrying",
      render: home({ ...fresh, computer: "failed" }, true),
    },
    computer_ready: {
      label: "Computer ready",
      render: home({ ...fresh, computer: "ready" }),
    },
    partial: {
      label: "Partially set up",
      render: home({ ...fresh, computer: "ready", telegramLinked: true }),
    },
    set_up: { label: "Fully set up", render: home(setUp) },
    attention: {
      label: "Attention needed",
      render: home({
        ...setUp,
        attention: [
          {
            id: "expiring",
            tone: "attention",
            title: "Your work account's access expires tomorrow",
            description:
              "Reconnect ada@work.example so Winston can keep helping with it.",
            action: {
              label: "Reconnect",
              href: "/auth/google/connect?reconnect=acct_1",
            },
          },
        ],
      }),
    },
    unreachable: {
      label: "Computer not responding",
      render: home({ ...setUp, computer: "unreachable" }),
    },
  },
};
