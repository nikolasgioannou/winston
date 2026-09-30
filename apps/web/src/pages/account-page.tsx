import { Link } from "@tanstack/react-router";
import type { ConnectionDto, RenameResult } from "@winston/db/connections";
import {
  capabilitiesByDomain,
  type Capability,
} from "@winston/domain/connections";
import {
  Button,
  Callout,
  ConfirmDialog,
  Section,
  SettingRow,
  Switch,
  TextField,
} from "@winston/ui";
import { ChevronLeft } from "lucide-react";
import { useState, type ReactNode } from "react";

/** Where a toggle's save stands, as the row shows it. */
export type SaveState = "saving" | "saved" | "error";

export interface AccountPageProps {
  account: ConnectionDto;
  /** Capabilities whose Google scope wasn't granted. */
  unavailable: readonly Capability[];
  /** Toggles as they show, including ones still saving. */
  capabilities: ConnectionDto["capabilities"];
  saves: Partial<Record<Capability, SaveState>>;
  onToggle: (capability: Capability, enabled: boolean) => void;
  onRename: (alias: string) => Promise<RenameResult>;
  onDisconnect: () => void;
  /** Opens the disconnect confirmation, for the dev design view. */
  confirmingDisconnect?: boolean;
}

const capabilityCopy: Record<
  Capability,
  { label: string; description: string }
> = {
  // Reading depends on the domain (`readCopy`).
  read: { label: "Read", description: "" },
  draft: {
    label: "Draft",
    description: "Write drafts that you review and send yourself.",
  },
  send: { label: "Send", description: "Send email as you." },
  modify_labels: {
    label: "Organize",
    description: "Archive, label and mark messages as read.",
  },
  create: {
    label: "Create events",
    description: "Add events to your calendars.",
  },
  update: { label: "Change events", description: "Move and edit events." },
  delete: { label: "Delete events", description: "Remove events." },
  rsvp: {
    label: "Respond to invitations",
    description: "Accept or decline invitations for you.",
  },
};

const readCopy: Record<ConnectionDto["domain"], string> = {
  mail: "Search and read, so Winston can answer and keep track.",
  calendar: "See your calendars and events.",
};

/**
 * `/accounts/<id>` (docs/design.md §20): one connection's name, what Winston
 * may do with it (the toggles the server enforces), reconnecting and
 * disconnecting.
 */
export function AccountPage(props: AccountPageProps) {
  const { account } = props;
  const disconnected = account.status === "disconnected";
  const reconnect = (
    <Button
      size="sm"
      nativeButton={false}
      render={<a href={`/auth/google/connect?reconnect=${account.id}`} />}
    >
      Reconnect
    </Button>
  );
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-10 px-6 py-8 sm:px-10">
      <header className="flex flex-col gap-3">
        <Link
          to="/accounts"
          className="-ml-1 flex w-fit items-center gap-0.5 rounded-md py-0.5 pr-1.5 text-sm text-fg-muted hover:bg-hover hover:text-fg"
        >
          <ChevronLeft className="size-4" />
          Connected accounts
        </Link>
        <div className="flex flex-col gap-1.5">
          <h1 className="text-title font-semibold text-fg">
            {account.alias ?? account.externalEmail}
          </h1>
          <p className="text-sm text-fg-muted">
            {account.domain === "mail" ? "Gmail" : "Google Calendar"} ·{" "}
            {account.externalEmail}
          </p>
        </div>
        <StatusCallout status={account.status} action={reconnect} />
      </header>

      <Section title="Name">
        <AliasField key={account.alias} {...props} />
      </Section>

      <Section title="What Winston can do">
        {capabilitiesByDomain[account.domain].map((capability) => (
          <CapabilityRow
            key={capability}
            capability={capability}
            domain={account.domain}
            {...props}
            disabled={disconnected}
            reconnect={reconnect}
          />
        ))}
      </Section>

      <Section title="Connection">
        <SettingRow
          label="Reconnect"
          description="Sign in to Google again, for example to grant a permission you left out."
          control={reconnect}
        />
        {!disconnected && (
          <SettingRow
            label="Disconnect"
            description="Winston stops using this account, and its access is revoked with Google."
            control={<DisconnectButton {...props} />}
          />
        )}
      </Section>
    </div>
  );
}

function StatusCallout({
  status,
  action,
}: {
  status: ConnectionDto["status"];
  action: ReactNode;
}) {
  switch (status) {
    case "ok":
      return null;
    case "expiring":
      return (
        <Callout tone="attention" title="Access expires soon" action={action}>
          Reconnect so Winston can keep helping with this account.
        </Callout>
      );
    case "expired":
      return (
        <Callout tone="error" title="Access expired" action={action}>
          Winston can't use this account until you reconnect it.
        </Callout>
      );
    case "disconnected":
      return (
        <Callout tone="neutral" title="Disconnected" action={action}>
          Winston doesn't use this account. Reconnect to bring it back.
        </Callout>
      );
  }
}

function AliasField({ account, onRename }: AccountPageProps) {
  const [alias, setAlias] = useState(account.alias ?? "");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const changed = alias.trim() !== (account.alias ?? "");

  const save = async () => {
    setSaving(true);
    setError(undefined);
    const result = await onRename(alias.trim());
    setSaving(false);
    if (!result.ok)
      setError(
        result.problem === "taken"
          ? "Another account already has that name."
          : "Use lowercase letters, numbers, dots, dashes or underscores, starting with a letter or number.",
      );
  };

  return (
    <form
      className="flex items-start gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <TextField
        aria-label="Name"
        value={alias}
        onChange={(event) => {
          setAlias(event.target.value);
          setError(undefined);
        }}
        description={
          error === undefined
            ? `What you and Winston call it, as in "check my ${alias.trim() || "work"} email".`
            : undefined
        }
        error={error}
        className="max-w-80 flex-1"
      />
      <Button type="submit" disabled={!changed || saving}>
        {saving ? "Saving…" : "Save"}
      </Button>
    </form>
  );
}

function CapabilityRow({
  capability,
  domain,
  unavailable,
  capabilities,
  saves,
  onToggle,
  disabled,
  reconnect,
}: AccountPageProps & {
  capability: Capability;
  domain: ConnectionDto["domain"];
  disabled: boolean;
  reconnect: ReactNode;
}) {
  const copy = capabilityCopy[capability];
  const description =
    capability === "read" ? readCopy[domain] : copy.description;
  if (unavailable.includes(capability))
    return (
      <SettingRow
        label={copy.label}
        description={`${description} Not granted on Google's screen; reconnect to enable.`}
        control={reconnect}
      />
    );
  const save = saves[capability];
  return (
    <SettingRow
      label={copy.label}
      description={
        save === "error" ? (
          <span className="text-error-text">Couldn't save. Try again.</span>
        ) : (
          description
        )
      }
      control={
        <span className="flex items-center gap-3">
          {save === "saving" && (
            <span className="text-caption text-fg-muted">Saving…</span>
          )}
          {save === "saved" && (
            <span className="text-caption text-fg-muted">Saved</span>
          )}
          <Switch
            aria-label={copy.label}
            checked={capabilities[capability] === true}
            disabled={disabled}
            onCheckedChange={(checked) => {
              onToggle(capability, checked);
            }}
          />
        </span>
      }
    />
  );
}

function DisconnectButton({
  account,
  onDisconnect,
  confirmingDisconnect,
}: AccountPageProps) {
  return (
    <ConfirmDialog
      {...(confirmingDisconnect ? { defaultOpen: true } : {})}
      trigger={<Button variant="danger">Disconnect</Button>}
      title={`Disconnect ${account.alias ?? account.externalEmail}?`}
      description={`Winston stops using ${account.externalEmail}, and its access is revoked with Google. You can connect it again any time.`}
      confirmLabel="Disconnect"
      onConfirm={onDisconnect}
    />
  );
}
