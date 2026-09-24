import type { AuthorizationRequest } from "@winston/contracts/authorization";
import type { Connection } from "@winston/contracts/connections";
import type { RegisteredDevice } from "@winston/contracts/device-registry";
import type { RegisteredWorkspace } from "@winston/contracts/workspace";

export type ScopeChoice = {
  label: string;
  target: AuthorizationRequest["target"];
  operations: AuthorizationRequest["operation"][];
  unavailable: boolean;
};
export type ScopeCatalog = { kind: "loading" | "error" } | { kind: "ready"; items: ScopeChoice[] };
const deviceOperations = {
  command: "device.command",
  "file.read": "device.file.read",
  "file.write": "device.file.write",
  observe: "device.observe",
  input: "device.input",
  application: "device.application",
} as const;

export function scopeOptions(
  connections: Connection[],
  devices: RegisteredDevice[],
  workspaces: RegisteredWorkspace[],
): ScopeChoice[] {
  return [
    ...connections.flatMap((connection): ScopeChoice[] => {
      const unavailable = !["connected", "limited"].includes(connection.status);
      const label = `${connection.service === "gmail" ? "Gmail" : "Calendar"} · ${connection.email}${unavailable ? ` · ${connection.status}` : ""}`;
      return connection.service === "gmail"
        ? [
            {
              label,
              unavailable,
              target: { kind: "connection", id: connection.id, resource: null },
              operations: ["gmail.read", "gmail.draft", "gmail.send", "gmail.modify"],
            },
          ]
        : [
            {
              label,
              unavailable,
              target: { kind: "connection", id: connection.id, resource: null },
              operations: ["calendar.list"],
            },
            ...connection.calendars.map((calendar): ScopeChoice => ({
              label: `${label} · ${calendar}`,
              unavailable,
              target: { kind: "connection", id: connection.id, resource: calendar },
              operations: ["calendar.read", "calendar.write"],
            })),
          ];
    }),
    ...devices.map((device): ScopeChoice => ({
      label: `${device.name}${device.revoked ? " · revoked" : ""}`,
      target: { kind: "device", id: device.id, resource: null },
      operations: device.capabilities.map((capability) => deviceOperations[capability]),
      unavailable: device.revoked,
    })),
    ...workspaces.map((workspace): ScopeChoice => ({
      label: `${workspace.name}${workspace.state === "active" ? "" : ` · ${workspace.state}`}`,
      target: { kind: "workspace", id: workspace.id, resource: null },
      operations: ["workspace.command", "workspace.file.read", "workspace.file.write"],
      unavailable: workspace.state !== "active",
    })),
  ];
}
