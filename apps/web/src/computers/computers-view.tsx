import { Badge, Button } from "@winston/ui";
import type { ReactNode } from "react";
import type { RegisteredDevice } from "@winston/contracts/device-registry";
import type { workspaceListSchema } from "@winston/contracts/workspace";
import { DeviceCard, type DeviceChange } from "./device-card";
import type { PresenceState } from "./presence";

export type ComputersState =
  | { kind: "loading" | "error" }
  | {
      kind: "ready";
      devices: RegisteredDevice[];
      workspaces: ReturnType<typeof workspaceListSchema.parse>["items"];
    };

export function ComputersView({
  state,
  presence,
  busy = false,
  saving = false,
  failed = false,
  more = false,
  pairing,
  version = 0,
  onRefresh,
  onMore,
  onChange,
}: {
  state: ComputersState;
  presence: PresenceState;
  busy?: boolean;
  saving?: boolean;
  failed?: boolean;
  more?: boolean;
  pairing?: ReactNode;
  version?: number;
  onRefresh: () => void;
  onMore: () => void;
  onChange: (change: DeviceChange) => void;
}) {
  return (
    <>
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-xl font-medium">Computers</h1>
        <Button variant="quiet" disabled={busy} onClick={onRefresh}>
          Refresh
        </Button>
      </div>
      {state.kind === "loading" ? (
        <p role="status" className="text-sm text-muted">
          Loading computers…
        </p>
      ) : null}
      {state.kind === "error" ? (
        <p role="alert" className="text-sm text-muted">
          Unable to load computers. Refresh to try again.
        </p>
      ) : null}
      {saving ? (
        <p role="status" className="text-sm text-muted">
          Saving changes…
        </p>
      ) : null}
      {failed ? (
        <p role="alert" className="text-sm text-muted">
          Could not confirm the change. Refresh before making another change.
        </p>
      ) : null}
      {state.kind === "ready" ? (
        <>
          <section className="space-y-4" aria-label="Cloud computers">
            <h2 className="text-sm font-medium">Cloud computers</h2>
            {!state.workspaces.length ? (
              <p className="text-sm text-muted">No cloud computers.</p>
            ) : null}
            <div className="divide-y divide-line">
              {state.workspaces.map((workspace) => (
                <div
                  key={workspace.id}
                  className="flex flex-wrap items-center gap-3 py-4 first:pt-0"
                >
                  <h3 className="text-sm wrap-anywhere">{workspace.name}</h3>
                  <Badge>
                    {workspace.state === "active"
                      ? "Enabled"
                      : workspace.state === "paused"
                        ? "Paused"
                        : "Retired"}
                  </Badge>
                </div>
              ))}
            </div>
            {more ? (
              <Button disabled={busy} onClick={onMore}>
                More cloud computers
              </Button>
            ) : null}
          </section>
          <section className="space-y-4 border-t border-line pt-5" aria-label="Your computers">
            <h2 className="text-sm font-medium">Your computers</h2>
            {pairing}
            {presence.kind === "error" && state.devices.some((device) => !device.revoked) ? (
              <p role="alert" className="text-sm text-muted">
                Unable to refresh availability.
              </p>
            ) : null}
            {!state.devices.length ? (
              <p className="text-sm text-muted">No registered computers.</p>
            ) : null}
            <div className="divide-y divide-line">
              {state.devices.map((device) => (
                <DeviceCard
                  key={`${device.id}:${String(version)}`}
                  device={device}
                  presence={presence}
                  disabled={busy || failed}
                  onChange={onChange}
                />
              ))}
            </div>
          </section>
        </>
      ) : null}
    </>
  );
}
