import type { MailboxState } from "@winston/db/mailbox";
import {
  mailboxAddress,
  mailboxNameProblem,
  normalizeMailboxName,
} from "@winston/domain/mailbox";
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

const on: MailboxState = {
  status: "on",
  address: "ada@runwinston.email",
  aliases: [],
  changesLeft: 2,
};

/** Checks names as the server would, with "nik" and "bob" taken. */
const checkName: ChannelsPageProps["checkMailboxName"] = (name) => {
  const normalized = normalizeMailboxName(name);
  const problem =
    mailboxNameProblem(normalized) ??
    (["nik", "bob"].includes(normalized) ? "taken" : undefined);
  return Promise.resolve(
    problem
      ? { ok: false, problem }
      : { ok: true, address: mailboxAddress(normalized) },
  );
};

const channels = (props: Partial<ChannelsPageProps>) => () => (
  <AppShell activePath="/channels" drawerOpen={false} onDrawerOpenChange={noop}>
    <ChannelsPage
      telegram={null}
      telegramLink={fixtureTelegramLink}
      connecting={false}
      onConnectingChange={noop}
      onDisconnectTelegram={noop}
      mailbox={{ status: "never" }}
      mailboxDialog={null}
      onMailboxDialogChange={noop}
      checkMailboxName={checkName}
      onSetUpMailbox={() => Promise.resolve(undefined)}
      onChangeMailboxAddress={() => Promise.resolve(undefined)}
      onTurnOnMailbox={noop}
      onTurnOffMailbox={noop}
      onCopyAddress={noop}
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
    email_on: {
      label: "Email on",
      render: channels({ telegram: linked, mailbox: on }),
    },
    email_setup: {
      label: "Email set-up",
      render: channels({ telegram: linked, mailboxDialog: "setup" }),
    },
    email_setup_available: {
      label: "Email set-up, name available",
      render: channels({
        telegram: linked,
        mailboxDialog: "setup",
        mailboxDialogName: "ada",
      }),
    },
    email_setup_taken: {
      label: "Email set-up, name taken",
      render: channels({
        telegram: linked,
        mailboxDialog: "setup",
        mailboxDialogName: "nik",
        mailboxDialogProblem: "taken",
      }),
    },
    email_setup_invalid: {
      label: "Email set-up, invalid name",
      render: channels({
        telegram: linked,
        mailboxDialog: "setup",
        mailboxDialogName: "ada_l",
        mailboxDialogProblem: "invalid_characters",
      }),
    },
    email_setup_reserved: {
      label: "Email set-up, reserved name",
      render: channels({
        telegram: linked,
        mailboxDialog: "setup",
        mailboxDialogName: "postmaster",
        mailboxDialogProblem: "reserved",
      }),
    },
    email_change: {
      label: "Changing the address",
      render: channels({
        telegram: linked,
        mailbox: { ...on, aliases: ["ada.l@runwinston.email"], changesLeft: 1 },
        mailboxDialog: "change",
      }),
    },
    email_no_changes: {
      label: "Email on, no changes left",
      render: channels({
        telegram: linked,
        mailbox: {
          ...on,
          aliases: ["ada.l@runwinston.email", "lovelace@runwinston.email"],
          changesLeft: 0,
        },
      }),
    },
    email_turning_off: {
      label: "Turn off email confirmation",
      render: channels({
        telegram: linked,
        mailbox: on,
        confirmingMailboxOff: true,
      }),
    },
    email_off: {
      label: "Email off",
      render: channels({
        telegram: linked,
        mailbox: { ...on, status: "off" },
      }),
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
