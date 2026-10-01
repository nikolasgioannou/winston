import type { ProfileUpdateResult } from "@winston/db/profile";
import {
  Button,
  ConfirmDialog,
  IconButton,
  Menu,
  Page,
  PageHeader,
  Section,
  SettingRow,
  StatusPill,
  TelegramIcon,
  TextField,
} from "@winston/ui";
import { MoreHorizontal } from "lucide-react";
import { useRef, useState } from "react";
import { TelegramConnectDialog } from "../components/telegram-connect";
import type { TelegramLinkState } from "../server/telegram-state";

export interface ProfilePageProps {
  email: string;
  firstName: string;
  lastName: string;
  onSaveName: (name: {
    firstName: string;
    lastName: string;
  }) => Promise<ProfileUpdateResult>;
  onDeleteAccount: () => void;
  /** Opens the deletion confirmation, for the dev design view. */
  confirmingDelete?: boolean;
  telegram: TelegramLinkState | null;
  /** The Connect Telegram link while connecting (null until issued). */
  telegramLink: string | null;
  /** The connect dialog is open (connecting, or changing the account). */
  connecting: boolean;
  onConnectingChange: (connecting: boolean) => void;
  onDisconnectTelegram: () => void;
  /** Opens the disconnect confirmation, for the dev design view. */
  confirmingTelegramDisconnect?: boolean;
}

/** Fields beside their labels share one width. */
const fieldWidth = "w-56 sm:w-64";

/**
 * `/profile` (docs/design.md §20): cards for the user, their Telegram link,
 * and account actions. The time zone isn't here: it follows the browser.
 */
export function ProfilePage(props: ProfilePageProps) {
  return (
    <Page>
      <PageHeader title="Profile" />
      <Section title="You" card>
        <NameFields {...props} />
        <SettingRow
          label="Email"
          control={
            <TextField
              aria-label="Email"
              value={props.email}
              disabled
              className={fieldWidth}
            />
          }
        />
      </Section>
      <TelegramCard {...props} />
      <Section title="Account" card>
        <SettingRow
          label="Sign out"
          control={
            <form method="post" action="/auth/sign-out">
              <Button type="submit">Sign out</Button>
            </form>
          }
        />
        <SettingRow
          label="Delete account"
          control={
            <ConfirmDialog
              {...(props.confirmingDelete ? { defaultOpen: true } : {})}
              trigger={<Button variant="danger">Delete account</Button>}
              title="Delete your account?"
              description="Your computer, its files, your connected accounts, your conversations and everything Winston knows about you will be deleted. Winston says goodbye in Telegram. This can't be undone."
              confirmText="delete"
              confirmLabel="Delete everything"
              onConfirm={props.onDeleteAccount}
            />
          }
        />
      </Section>
    </Page>
  );
}

/**
 * First and last name, each saved quietly when the field loses focus. A
 * first name is required, so clearing it puts the saved one back.
 */
function NameFields({ firstName, lastName, onSaveName }: ProfilePageProps) {
  const [first, setFirst] = useState(firstName);
  const [last, setLast] = useState(lastName);
  // What's saved, as the fields last committed it.
  const committed = useRef({ firstName, lastName });

  const commit = async () => {
    const name = { firstName: first.trim(), lastName: last.trim() };
    if (name.firstName === "") {
      setFirst(committed.current.firstName);
      return;
    }
    if (
      name.firstName === committed.current.firstName &&
      name.lastName === committed.current.lastName
    )
      return;
    const result = await onSaveName(name);
    if (!result.ok) {
      setFirst(committed.current.firstName);
      setLast(committed.current.lastName);
      return;
    }
    committed.current = name;
  };

  return (
    <>
      <SettingRow
        label="First name"
        control={
          <TextField
            aria-label="First name"
            value={first}
            onChange={(event) => {
              setFirst(event.target.value);
            }}
            onBlur={() => void commit()}
            className={fieldWidth}
          />
        }
      />
      <SettingRow
        label="Last name"
        control={
          <TextField
            aria-label="Last name"
            value={last}
            onChange={(event) => {
              setLast(event.target.value);
            }}
            onBlur={() => void commit()}
            className={fieldWidth}
          />
        }
      />
    </>
  );
}

/**
 * Channels: the ways the user reaches Winston, laid out like connected
 * accounts. Just Telegram for now; an email address for Winston would join it.
 */
function TelegramCard({
  telegram,
  telegramLink,
  connecting,
  onConnectingChange,
  onDisconnectTelegram,
  confirmingTelegramDisconnect,
}: ProfilePageProps) {
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
      <Section title="Channels" card>
        <SettingRow
          icon={icon}
          label="Telegram"
          control={
            <span className="flex items-center gap-3">
              <StatusPill tone="neutral">Not connected</StatusPill>
              <Button
                onClick={() => {
                  onConnectingChange(true);
                }}
              >
                Connect
              </Button>
            </span>
          }
        />
        {dialog}
      </Section>
    );

  // Like a connected account: the service, then which account it is.
  const account =
    telegram.displayName ??
    (telegram.username ? `@${telegram.username}` : undefined);
  return (
    <Section title="Channels" card>
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
    </Section>
  );
}
