import { useQuery } from "@tanstack/react-query";
import { connectionListSchema } from "@winston/contracts/connections";
import { registeredDeviceListSchema } from "@winston/contracts/device-registry";
import type { Responsibility } from "@winston/contracts/responsibilities";
import { ownerJson } from "../management/api";
import type { ScopeNames } from "./scope";

export function useScopeNames(items: Responsibility[]) {
  const needsConnections = items.some((item) =>
    item.scope.some(({ target }) => target.kind === "connection"),
  );
  const needsDevices = items.some((item) =>
    item.scope.some(({ target }) => target.kind === "device"),
  );
  const connections = useQuery({
    queryKey: ["responsibility-account-names"],
    enabled: needsConnections,
    queryFn: ({ signal }) => ownerJson("/api/owner/connections", connectionListSchema, { signal }),
  });
  const devices = useQuery({
    queryKey: ["responsibility-device-names"],
    enabled: needsDevices,
    queryFn: ({ signal }) =>
      ownerJson("/api/owner/devices", registeredDeviceListSchema, { signal }),
  });
  const names: ScopeNames = {};
  for (const connection of connections.data ?? [])
    names[`connection:${connection.id}`] = connection.email;
  for (const device of devices.data ?? []) names[`device:${device.id}`] = device.name;
  return {
    names,
    ready: (!needsConnections || connections.isSuccess) && (!needsDevices || devices.isSuccess),
    refresh: () =>
      Promise.all([
        ...(needsConnections ? [connections.refetch()] : []),
        ...(needsDevices ? [devices.refetch()] : []),
      ]),
  };
}
