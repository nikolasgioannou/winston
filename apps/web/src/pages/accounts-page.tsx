import type { ConnectionDto } from "@winston/db/connections";
import {
  Badge,
  EmptyState,
  IconTile,
  LinkCard,
  linkCardRow,
  Page,
  PageHeader,
  StatusPill,
} from "@winston/ui";
import { Link } from "@tanstack/react-router";
import { Blocks, ChevronRight } from "lucide-react";
import { AddAccountDialog } from "../components/add-account-dialog";
import {
  domainNames,
  ProviderIcon,
  providerNames,
} from "../components/providers";

/**
 * `/accounts` (docs/design.md §20): the user's connected Google accounts,
 * any number per domain, and a way to add more.
 */
export function AccountsPage({
  connections,
  addingAccount,
}: {
  connections: readonly ConnectionDto[];
  /** Opens Add account, for the dev design view. */
  addingAccount?: boolean;
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
        <LinkCard>
          {connections.map((connection) => (
            <AccountRow key={connection.id} connection={connection} />
          ))}
        </LinkCard>
      )}
    </Page>
  );
}

function AccountRow({ connection }: { connection: ConnectionDto }) {
  return (
    <Link
      to="/accounts/$accountId"
      params={{ accountId: connection.id }}
      className={linkCardRow}
    >
      <IconTile>
        <ProviderIcon provider={connection.provider} />
      </IconTile>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <span className="text-sm font-medium text-fg">
            {providerNames[connection.provider]}
          </span>
          <Badge>{domainNames[connection.domain]}</Badge>
        </span>
        <span className="truncate text-caption text-fg-muted">
          {connection.externalEmail}
        </span>
      </div>
      <Status status={connection.status} />
      <ChevronRight className="size-4 shrink-0 text-icon" />
    </Link>
  );
}

function Status({ status }: { status: ConnectionDto["status"] }) {
  switch (status) {
    case "ok":
      return null;
    case "expiring":
      return <StatusPill tone="attention">Expires soon</StatusPill>;
    case "expired":
      return <StatusPill tone="error">Expired</StatusPill>;
    case "disconnected":
      return <StatusPill tone="neutral">Disconnected</StatusPill>;
  }
}
