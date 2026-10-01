import { AppShell } from "../components/app-shell";
import { AccountDialog, type AccountDialogProps } from "./account-dialog";
import { AccountsPage } from "./accounts-page";
import { personalCalendar, personalMail, work } from "./accounts-page.fixtures";
import type { PageFixtures } from "./fixtures";

const noop = () => undefined;

const page = (props: Partial<AccountDialogProps>) => () => {
  const account = props.account ?? work;
  return (
    <AppShell
      activePath="/accounts"
      drawerOpen={false}
      onDrawerOpenChange={noop}
    >
      <AccountsPage connections={[work, personalMail, personalCalendar]}>
        <AccountDialog
          account={account}
          unavailable={[]}
          capabilities={account.capabilities}
          saves={{}}
          onToggle={noop}
          onDisconnect={noop}
          open
          onOpenChange={noop}
          {...props}
        />
      </AccountsPage>
    </AppShell>
  );
};

/** The account dialog's states for the dev design view. */
export const accountFixtures: PageFixtures = {
  title: "Account dialog",
  path: "/accounts?account=<acct_id>",
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
      render: page({ confirmingDisconnect: true, defaultTab: "connection" }),
    },
    connection: {
      label: "Connection tab",
      render: page({ defaultTab: "connection" }),
    },
    disconnected: {
      label: "Disconnected",
      render: page({ account: { ...work, status: "disconnected" } }),
    },
  },
};
