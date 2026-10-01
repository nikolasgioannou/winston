import type { ConnectionDto } from "@winston/db/connections";
import {
  Badge,
  Card,
  ConfirmDialog,
  EmptyState,
  IconButton,
  Menu,
  Page,
  PageHeader,
  SettingRow,
  StatusPill,
} from "@winston/ui";
import { Blocks, MoreHorizontal } from "lucide-react";
import { useState, type ReactNode } from "react";
import { AddAccountDialog } from "../components/add-account-dialog";
import {
  domainNames,
  ProviderIcon,
  providerNames,
} from "../components/providers";

/**
 * `/accounts` (docs/design.md §20): the user's connected Google accounts,
 * any number per domain, and a way to add more. Each row's menu opens the
 * account's permissions in a dialog over the list, reconnects or
 * disconnects it.
 */
export function AccountsPage({
  connections,
  onManage,
  onReconnect,
  onDisconnect,
  addingAccount,
  confirmingDisconnect,
  children,
}: {
  connections: readonly ConnectionDto[];
  /** Opens an account's permissions. */
  onManage: (connectionId: string) => void;
  onReconnect: (connectionId: string) => void;
  onDisconnect: (connectionId: string) => void;
  /** Opens Add account, for the dev design view. */
  addingAccount?: boolean;
  /** Opens one account's disconnect confirmation, for the dev design view. */
  confirmingDisconnect?: string;
  /** The open account's dialog, if any. */
  children?: ReactNode;
}) {
  const add = (
    <AddAccountDialog {...(addingAccount ? { defaultOpen: true } : {})} />
  );
  return (
    <Page>
      <PageHeader
        title="Connected accounts"
        {...(connections.length > 0 ? { action: add } : {})}
      />
      {connections.length === 0 ? (
        <EmptyState
          icon={<Blocks />}
          title="No accounts yet"
          description="Connect Gmail or Google Calendar, and Winston can read, draft and keep track for you."
          action={add}
        />
      ) : (
        <Card>
          {connections.map((connection) => (
            <AccountRow
              key={connection.id}
              connection={connection}
              onManage={onManage}
              onReconnect={onReconnect}
              onDisconnect={onDisconnect}
              confirming={confirmingDisconnect === connection.id}
            />
          ))}
        </Card>
      )}
      {children}
    </Page>
  );
}

/**
 * One account, laid out like Profile's channels: the provider and its type,
 * the address under it, a status badge and a ⋯ menu of what to do with it.
 */
function AccountRow({
  connection,
  onManage,
  onReconnect,
  onDisconnect,
  confirming: confirmingAtFirst,
}: {
  connection: ConnectionDto;
  onManage: (connectionId: string) => void;
  onReconnect: (connectionId: string) => void;
  onDisconnect: (connectionId: string) => void;
  confirming: boolean;
}) {
  const [confirming, setConfirming] = useState(confirmingAtFirst);
  const disconnected = connection.status === "disconnected";
  return (
    <SettingRow
      icon={<ProviderIcon provider={connection.provider} />}
      label={
        <span className="flex items-center gap-2">
          {providerNames[connection.provider]}
          <Badge>{domainNames[connection.domain]}</Badge>
        </span>
      }
      description={connection.externalEmail}
      control={
        <span className="flex items-center gap-2">
          <Status status={connection.status} />
          <Menu
            trigger={
              <IconButton label={`${connection.externalEmail} options`}>
                <MoreHorizontal />
              </IconButton>
            }
            actions={[
              {
                label: "Manage permissions",
                onSelect: () => {
                  onManage(connection.id);
                },
              },
              {
                label: "Reconnect",
                onSelect: () => {
                  onReconnect(connection.id);
                },
              },
              ...(disconnected
                ? []
                : [
                    {
                      label: "Disconnect",
                      danger: true,
                      onSelect: () => {
                        setConfirming(true);
                      },
                    },
                  ]),
            ]}
          />
          <ConfirmDialog
            open={confirming}
            onOpenChange={setConfirming}
            title={`Disconnect ${connection.externalEmail}?`}
            description={`Winston stops using ${connection.externalEmail}, and its access is revoked with Google. You can connect it again any time.`}
            confirmLabel="Disconnect"
            onConfirm={() => {
              onDisconnect(connection.id);
            }}
          />
        </span>
      }
    />
  );
}

function Status({ status }: { status: ConnectionDto["status"] }) {
  switch (status) {
    case "ok":
      return <StatusPill tone="ok">Connected</StatusPill>;
    case "expiring":
      return <StatusPill tone="attention">Expires soon</StatusPill>;
    case "expired":
      return <StatusPill tone="error">Expired</StatusPill>;
    case "disconnected":
      return <StatusPill tone="neutral">Disconnected</StatusPill>;
  }
}
