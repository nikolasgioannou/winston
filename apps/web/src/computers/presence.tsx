import { Badge } from "@winston/ui";
import type { DevicePresence } from "@winston/contracts/device-registry";

export type PresenceState =
  { kind: "loading" | "error" } | { kind: "ready"; items: DevicePresence[] };

const labels = {
  ready: "Ready",
  locked: "Locked",
  sleeping: "Sleeping",
  paused: "Paused",
  unreachable: "Unreachable",
};

export function Presence({ state, deviceId }: { state: PresenceState; deviceId: string }) {
  if (state.kind !== "ready")
    return <Badge>{state.kind === "loading" ? "Checking…" : "Unknown"}</Badge>;
  const value = state.items.find((item) => item.deviceId === deviceId);
  const status = value?.status ?? "unreachable";
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Badge tone={status === "ready" ? "success" : "neutral"}>{labels[status]}</Badge>
      {status === "unreachable" && value?.lastSeenAt ? (
        <span className="text-xs text-muted">
          Last seen{" "}
          <time dateTime={value.lastSeenAt}>{new Date(value.lastSeenAt).toLocaleString()}</time>
        </span>
      ) : null}
    </div>
  );
}
