import {
  Button,
  Card,
  ConfirmDialog,
  IconButton,
  Menu,
  Page,
  PageHeader,
  SettingRow,
  StatusPill,
  TelegramIcon,
} from "@winston/ui";
import { MoreHorizontal } from "lucide-react";
import { useState } from "react";
import { TelegramConnectDialog } from "../components/telegram-connect";
import type { TelegramLinkState } from "../server/telegram-state";

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
