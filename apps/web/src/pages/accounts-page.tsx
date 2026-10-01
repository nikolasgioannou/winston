import type { ConnectionDto } from "@winston/db/connections";
import {
  Badge,
  Button,
  EmptyState,
  LinkCard,
  linkCardRow,
  Menu,
  StatusPill,
  type MenuLink,
} from "@winston/ui";
import { Link } from "@tanstack/react-router";
import { Blocks, CalendarDays, ChevronRight, Mail } from "lucide-react";
import type { ReactNode } from "react";

const addLinks: MenuLink[] = [
  {
    label: "Gmail",
    href: "/auth/google/connect?domain=mail",
    icon: <Mail />,
  },
  {
    label: "Google Calendar",
    href: "/auth/google/connect?domain=calendar",
    icon: <CalendarDays />,
  },
];

const domainNames: Record<ConnectionDto["domain"], string> = {
  mail: "Mail",
  calendar: "Calendar",
};
const providerNames: Record<ConnectionDto["provider"], string> = {
  gmail: "Gmail",
  google_calendar: "Google Calendar",
};
const domainIcons: Record<ConnectionDto["domain"], ReactNode> = {
  mail: <Mail />,
  calendar: <CalendarDays />,
};

/**
 * `/accounts` (docs/design.md §20): the user's connected Google accounts,
 * any number per domain, and a way to add more.
 */
export function AccountsPage({
  connections,
}: {
  connections: readonly ConnectionDto[];
}) {
  const add = <Menu trigger={<Button>Add account</Button>} links={addLinks} />;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-8 sm:px-10">
      <header className="flex items-center justify-between gap-6">
        <h1 className="text-title font-semibold text-fg">Connected accounts</h1>
        {connections.length > 0 && add}
      </header>
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
    </div>
  );
}

function AccountRow({ connection }: { connection: ConnectionDto }) {
  return (
    <Link
      to="/accounts/$accountId"
      params={{ accountId: connection.id }}
      className={linkCardRow}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-surface-strong text-icon [&>svg]:size-4">
        {domainIcons[connection.domain]}
      </span>
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
