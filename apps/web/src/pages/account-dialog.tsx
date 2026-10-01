import type { ConnectionDto } from "@winston/db/connections";
import {
  capabilitiesByDomain,
  type Capability,
} from "@winston/domain/connections";
import {
  Badge,
  Button,
  Callout,
  Card,
  ConfirmDialog,
  Dialog,
  SettingRow,
  Switch,
} from "@winston/ui";
import type { ReactNode } from "react";
import {
  domainNames,
  ProviderIcon,
  providerNames,
} from "../components/providers";

export interface AccountDialogProps {
  account: ConnectionDto;
  /** Capabilities whose Google scope wasn't granted. */
  unavailable: readonly Capability[];
  /** Toggles as they show, including ones still saving. */
  capabilities: ConnectionDto["capabilities"];
  onToggle: (capability: Capability, enabled: boolean) => void;
  onDisconnect: () => void;
  /** Opens the disconnect confirmation, for the dev design view. */
  confirmingDisconnect?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The tab shown first, for the dev design view. */
  defaultTab?: "permissions" | "connection";
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
 * One connected account, in a dialog over `/accounts` (docs/design.md §20),
 * in two tabs: Permissions (the toggles the server enforces) and Connection
 * (reconnect, disconnect).
 */
export function AccountDialog(props: AccountDialogProps) {
  const { account, open, onOpenChange } = props;
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
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      {...(props.defaultTab ? { defaultTab: props.defaultTab } : {})}
      tabs={[
        {
          value: "permissions",
          label: "Permissions",
          content: (
            <Card>
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
            </Card>
          ),
        },
        {
          value: "connection",
          label: "Connection",
          content: (
            <Card>
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
            </Card>
          ),
        },
      ]}
      title={account.externalEmail}
      icon={<ProviderIcon provider={account.provider} />}
      description={
        <span className="flex items-center gap-2">
          {providerNames[account.provider]}
          <Badge>{domainNames[account.domain]}</Badge>
        </span>
      }
    >
      <StatusCallout status={account.status} action={reconnect} />
    </Dialog>
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

function CapabilityRow({
  capability,
  domain,
  unavailable,
  capabilities,
  onToggle,
  disabled,
  reconnect,
}: AccountDialogProps & {
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
  return (
    <SettingRow
      label={copy.label}
      description={description}
      control={
        <Switch
          aria-label={copy.label}
          checked={capabilities[capability] === true}
          disabled={disabled}
          onCheckedChange={(checked) => {
            onToggle(capability, checked);
          }}
        />
      }
    />
  );
}

function DisconnectButton({
  account,
  onDisconnect,
  confirmingDisconnect,
}: AccountDialogProps) {
  return (
    <ConfirmDialog
      {...(confirmingDisconnect ? { defaultOpen: true } : {})}
      trigger={<Button variant="danger">Disconnect</Button>}
      title={`Disconnect ${account.externalEmail}?`}
      description={`Winston stops using ${account.externalEmail}, and its access is revoked with Google. You can connect it again any time.`}
      confirmLabel="Disconnect"
      onConfirm={onDisconnect}
    />
  );
}
