import { AppShell } from "../components/app-shell";
import { AccountPage, type AccountPageProps } from "./account-page";
import { personalCalendar, work } from "./accounts-page.fixtures";
import type { PageFixtures } from "./fixtures";

const noop = () => undefined;

const page = (props: Partial<AccountPageProps>) => () => {
  const account = props.account ?? work;
  return (
    <AppShell
      activePath="/accounts"
      drawerOpen={false}
      onDrawerOpenChange={noop}
    >
      <AccountPage
        account={account}
        unavailable={[]}
        capabilities={account.capabilities}
        saves={{}}
        onToggle={noop}
        onDisconnect={noop}
        {...props}
      />
    </AppShell>
  );
};

/** One account's states for the dev design view. */
export const accountFixtures: PageFixtures = {
  title: "Account",
  path: "/accounts/<acct_id>",
  states: {
    mail: { label: "Mail", render: page({}) },
    saving: {
      label: "Toggle saving",
      render: page({
        capabilities: { ...work.capabilities, send: true },
        saves: { send: "saving" },
      }),
    },
    saved: {
      label: "Toggle saved",
      render: page({ saves: { draft: "saved" } }),
    },
    error: {
      label: "Toggle error",
      render: page({ saves: { send: "error" } }),
    },
    unavailable: {
      label: "Unavailable capability",
      render: page({
        account: personalCalendar,
        unavailable: ["create", "update", "delete", "rsvp"],
      }),
    },
    calendar: {
      label: "Calendar, expired",
      render: page({
        account: { ...personalCalendar, status: "expired" },
      }),
    },
    confirming: {
      label: "Disconnect confirmation",
      render: page({ confirmingDisconnect: true }),
    },
    disconnected: {
      label: "Disconnected",
      render: page({ account: { ...work, status: "disconnected" } }),
    },
  },
};
