import type { ConnectionDto } from "@winston/db/connections";
import { AppShell } from "../components/app-shell";
import { AccountsPage } from "./accounts-page";
import type { PageFixtures } from "./fixtures";

const noop = () => undefined;

const account = (
  overrides: Partial<ConnectionDto> & Pick<ConnectionDto, "id">,
): ConnectionDto => ({
  domain: "mail",
  provider: "gmail",
  externalEmail: "ada@acme.com",
  scopes: ["gmail.modify"],
  capabilities: { read: true, draft: true, send: false, modify_labels: false },
  grantedAt: "2026-09-29T12:00:00.000Z",
  status: "ok",
  createdAt: "2026-09-29T12:00:00.000Z",
  ...overrides,
});

export const work = account({ id: "acct_1" });
export const personalMail = account({
  id: "acct_2",
  externalEmail: "ada.lovelace@gmail.com",
});
export const personalCalendar = account({
  id: "acct_3",
  domain: "calendar",
  provider: "google_calendar",
  externalEmail: "ada.lovelace@gmail.com",
  scopes: ["calendar.events"],
});

const accounts =
  (
    connections: ConnectionDto[],
    addingAccount = false,
    confirmingDisconnect?: string,
  ) =>
  () => (
    <AppShell
      activePath="/accounts"
      drawerOpen={false}
      onDrawerOpenChange={noop}
    >
      <AccountsPage
        connections={connections}
        onManage={noop}
        onReconnect={noop}
        onDisconnect={noop}
        addingAccount={addingAccount}
        {...(confirmingDisconnect ? { confirmingDisconnect } : {})}
      />
    </AppShell>
  );

/** The accounts page's states for the dev design view. */
export const accountsFixtures: PageFixtures = {
  title: "Connected accounts",
  path: "/accounts",
  states: {
    empty: { label: "Empty", render: accounts([]) },
    few: {
      label: "A few accounts",
      render: accounts([work, personalMail, personalCalendar]),
    },
    disconnecting: {
      label: "Disconnect confirmation",
      render: accounts([work, personalMail, personalCalendar], false, work.id),
    },
    adding: {
      label: "Add account",
      render: accounts([work, personalMail], true),
    },
    expiring: {
      label: "One expiring",
      render: accounts([
        { ...work, status: "expiring" },
        personalMail,
        personalCalendar,
      ]),
    },
    expired: {
      label: "One expired",
      render: accounts([
        work,
        personalMail,
        { ...personalCalendar, status: "expired" },
      ]),
    },
  },
};
