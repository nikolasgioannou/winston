import { useState } from "react";
import type { RegisteredDevice } from "@winston/contracts/device-registry";
import { ComputersView, type ComputersState } from "../computers/computers-view";
import { ManagementShell } from "../management/shell";

const device: RegisteredDevice = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Studio Mac",
  platform: "macos",
  appVersion: "1.0.0",
  protocolVersion: 1,
  capabilities: ["command"],
  revision: 0,
  isDefault: false,
  revoked: false,
  createdAt: "2030-01-01T00:00:00.000Z",
};
const populated: ComputersState = {
  kind: "ready",
  devices: [device],
  workspaces: [
    {
      id: "22222222-2222-4222-8222-222222222222",
      name: "Winston's computer",
      state: "active",
      revision: 0,
    },
  ],
};

export function ComputersPreview({
  initial,
}: {
  initial:
    | "ready"
    | "empty"
    | "loading"
    | "error"
    | "saving"
    | "uncertain"
    | "unreachable"
    | "locked"
    | "sleeping"
    | "paused"
    | "presence-error"
    | "presence-loading";
}) {
  const [state, setState] = useState<ComputersState>(
    initial === "loading" || initial === "error"
      ? { kind: initial }
      : initial === "empty"
        ? { kind: "ready", devices: [], workspaces: [] }
        : populated,
  );
  const [failed, setFailed] = useState(initial === "uncertain");
  const [version, setVersion] = useState(0);
  return (
    <ManagementShell preview activeHref="/computers" onNavigate={() => {}}>
      <ComputersView
        key={version}
        state={state}
        presence={
          initial === "presence-error"
            ? { kind: "error" }
            : initial === "presence-loading"
              ? { kind: "loading" }
              : {
                  kind: "ready",
                  items: [
                    {
                      deviceId: device.id,
                      status:
                        initial === "unreachable" ||
                        initial === "locked" ||
                        initial === "sleeping" ||
                        initial === "paused"
                          ? initial
                          : "ready",
                      lastSeenAt: "2030-01-01T12:00:00.000Z",
                    },
                  ],
                }
        }
        busy={initial === "saving"}
        saving={initial === "saving"}
        failed={failed}
        onMore={() => {}}
        onRefresh={() => {
          setState(populated);
          setFailed(false);
          setVersion((current) => current + 1);
        }}
        onChange={(change) => {
          if (state.kind !== "ready") return;
          setState({
            ...state,
            devices: state.devices.map((item) =>
              item.id === change.device.id
                ? {
                    ...item,
                    revision: item.revision + 1,
                    name: change.action === "rename" ? change.name : item.name,
                    isDefault:
                      change.action === "revoke"
                        ? false
                        : change.action === "default" || item.isDefault,
                    revoked: change.action === "revoke" || item.revoked,
                  }
                : item,
            ),
          });
          setVersion((current) => current + 1);
        }}
      />
    </ManagementShell>
  );
}
