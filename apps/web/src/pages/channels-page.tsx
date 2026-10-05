import {
  Button,
  Card,
  ConfirmDialog,
  CopyText,
  IconButton,
  Menu,
  Page,
  PageHeader,
  SettingRow,
  StatusPill,
  TelegramIcon,
} from "@winston/ui";
import type { MailboxNameCheck, MailboxState } from "@winston/db/mailbox";
import { Mail, MoreHorizontal } from "lucide-react";
import { useState } from "react";
import {
  MailboxDialog,
  type MailboxProblem,
} from "../components/mailbox-dialog";
import { TelegramConnectDialog } from "../components/telegram-connect";
import type { TelegramLinkState } from "../server/telegram-state";

/** Which mailbox dialog is open. */
export type MailboxDialogMode = "setup" | "change" | null;

export interface ChannelsPageProps {
  telegram: TelegramLinkState | null;
  /** The Connect Telegram link while connecting (null until issued). */
  telegramLink: string | null;
  /** The connect dialog is open (connecting, or changing the account). */
  connecting: boolean;
  onConnectingChange: (connecting: boolean) => void;
  onDisconnectTelegram: () => void;
  /** Opens the disconnect confirmation, for the dev design view. */
  confirmingTelegramDisconnect?: boolean;
  mailbox: MailboxState;
  mailboxDialog: MailboxDialogMode;
  onMailboxDialogChange: (mode: MailboxDialogMode) => void;
  checkMailboxName: (name: string) => Promise<MailboxNameCheck>;
  /** Resolves with the problem, or undefined once it's done. */
  onSetUpMailbox: (name: string) => Promise<MailboxProblem | undefined>;
  onChangeMailboxAddress: (name: string) => Promise<MailboxProblem | undefined>;
  onTurnOnMailbox: () => void;
  onTurnOffMailbox: () => void;
  /** Copies to the clipboard; rejects if that failed. */
  onCopyAddress: (address: string) => Promise<void>;
  /** Opens the turn-off confirmation, for the dev design view. */
  confirmingMailboxOff?: boolean;
  /** Starts the open dialog with a name typed, for the dev design view. */
  mailboxDialogName?: string;
  mailboxDialogProblem?: MailboxProblem;
}

/**
 * `/channels` (docs/design.md §20): the ways the user reaches Winston, laid
 * out like connected accounts.
 */
export function ChannelsPage(props: ChannelsPageProps) {
  return (
    <Page>
      <PageHeader title="Channels" />
      <Card>
        <TelegramRow {...props} />
        <EmailRow {...props} />
      </Card>
    </Page>
  );
}

function TelegramRow({
  telegram,
  telegramLink,
  connecting,
  onConnectingChange,
  onDisconnectTelegram,
  confirmingTelegramDisconnect,
}: ChannelsPageProps) {
  const [confirming, setConfirming] = useState(
    confirmingTelegramDisconnect ?? false,
  );
  const icon = <TelegramIcon />;
  const dialog = (
    <TelegramConnectDialog
      url={telegramLink}
      changing={telegram !== null}
      open={connecting}
      onOpenChange={onConnectingChange}
    />
  );

  if (!telegram)
    return (
      <>
        <SettingRow
          icon={icon}
          label="Telegram"
          control={
            <Button
              onClick={() => {
                onConnectingChange(true);
              }}
            >
              Connect
            </Button>
          }
        />
        {dialog}
      </>
    );

  // Like a connected account: the service, then which account it is.
  const account =
    telegram.displayName ??
    (telegram.username ? `@${telegram.username}` : undefined);
  return (
    <>
      <SettingRow
        icon={icon}
        label="Telegram"
        {...(account !== undefined ? { description: account } : {})}
        control={
          <span className="flex items-center gap-2">
            <StatusPill tone="ok">Connected</StatusPill>
            <Menu
              trigger={
                <IconButton label="Telegram options">
                  <MoreHorizontal />
                </IconButton>
              }
              actions={[
                {
                  label: "Change account",
                  onSelect: () => {
                    onConnectingChange(true);
                  },
                },
                {
                  label: "Disconnect",
                  danger: true,
                  onSelect: () => {
                    setConfirming(true);
                  },
                },
              ]}
            />
          </span>
        }
      />
      {dialog}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Disconnect Telegram?"
        description="Winston won't be able to message you until you connect Telegram again."
        confirmLabel="Disconnect"
        onConfirm={onDisconnectTelegram}
      />
    </>
  );
}

/**
 * Winston's own email address: set it up, then copy, change or turn it off.
 * The address shows like a connected account's.
 */
function EmailRow({
  mailbox,
  mailboxDialog,
  onMailboxDialogChange,
  checkMailboxName,
  onSetUpMailbox,
  onChangeMailboxAddress,
  onTurnOnMailbox,
  onTurnOffMailbox,
  onCopyAddress,
  confirmingMailboxOff,
  mailboxDialogName,
  mailboxDialogProblem,
}: ChannelsPageProps) {
  const [confirming, setConfirming] = useState(confirmingMailboxOff ?? false);
  const icon = <Mail />;
  const preset = {
    ...(mailboxDialogName !== undefined
      ? { initialName: mailboxDialogName }
      : {}),
    ...(mailboxDialogProblem !== undefined
      ? { initialProblem: mailboxDialogProblem }
      : {}),
  };
  const onOpenChange = (open: boolean) => {
    if (!open) onMailboxDialogChange(null);
  };

  if (mailbox.status === "never")
    return (
      <>
        <SettingRow
          icon={icon}
          label="Email"
          control={
            <Button
              onClick={() => {
                onMailboxDialogChange("setup");
              }}
            >
              Set up
            </Button>
          }
        />
        <MailboxDialog
          // A fresh form each time it opens.
          key={String(mailboxDialog === "setup")}
          mode="setup"
          open={mailboxDialog === "setup"}
          onOpenChange={onOpenChange}
          checkName={checkMailboxName}
          onSubmit={onSetUpMailbox}
          {...preset}
        />
      </>
    );

  if (mailbox.status === "off")
    return (
      <SettingRow
        icon={icon}
        label={
          <span className="flex min-w-0 items-center gap-3">
            Email
            <span className="truncate text-caption font-normal text-fg-muted">
              {mailbox.address}
            </span>
          </span>
        }
        control={
          <span className="flex items-center gap-3">
            <StatusPill tone="neutral">Off</StatusPill>
            <Button onClick={onTurnOnMailbox}>Turn on</Button>
          </span>
        }
      />
    );

  return (
    <>
      <SettingRow
        icon={icon}
        label={
          <span className="flex min-w-0 items-center gap-3">
            Email
            <CopyText
              text={mailbox.address}
              copy={onCopyAddress}
              className="font-normal"
            />
          </span>
        }
        control={
          <span className="flex items-center gap-2">
            <StatusPill tone="ok">On</StatusPill>
            <Menu
              trigger={
                <IconButton label="Email options">
                  <MoreHorizontal />
                </IconButton>
              }
              actions={[
                // Once the changes are used up, there's nothing to offer.
                ...(mailbox.changesLeft > 0
                  ? [
                      {
                        label: "Change address",
                        onSelect: () => {
                          onMailboxDialogChange("change");
                        },
                      },
                    ]
                  : []),
                {
                  label: "Turn off",
                  danger: true,
                  onSelect: () => {
                    setConfirming(true);
                  },
                },
              ]}
            />
          </span>
        }
      />
      <MailboxDialog
        key={String(mailboxDialog === "change")}
        mode="change"
        open={mailboxDialog === "change"}
        onOpenChange={onOpenChange}
        current={mailbox.address}
        changesLeft={mailbox.changesLeft}
        checkName={checkMailboxName}
        onSubmit={onChangeMailboxAddress}
        {...preset}
      />
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Turn off Winston's email?"
        description={`Mail to ${mailbox.address} will bounce until you turn it back on. The address stays his.`}
        confirmLabel="Turn off"
        onConfirm={onTurnOffMailbox}
      />
    </>
  );
}
