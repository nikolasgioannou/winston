import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { connectionListSchema } from "@winston/contracts/connections";
import { registeredDeviceListSchema } from "@winston/contracts/device-registry";
import type { Responsibility } from "@winston/contracts/responsibilities";
import { ownerJson } from "../management/api";
import type { ScopeNames } from "./scope";
import { workspaceListSchema } from "@winston/contracts/workspace";

export function useScopeNames(items: Responsibility[], catalog = false) {
  const needsConnections =
    catalog || items.some((item) => item.scope.some(({ target }) => target.kind === "connection"));
  const needsDevices =
    catalog || items.some((item) => item.scope.some(({ target }) => target.kind === "device"));
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
  const needsWorkspaces =
    catalog || items.some((item) => item.scope.some(({ target }) => target.kind === "workspace"));
  const workspaces = useInfiniteQuery({
    queryKey: ["responsibility-workspace-names"],
    enabled: needsWorkspaces,
    queryFn: ({ pageParam, signal }) =>
      ownerJson(
        `/api/owner/workspaces${pageParam ? `?after=${pageParam}` : ""}`,
        workspaceListSchema,
        { signal },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next,
  });
  const computers = workspaces.data?.pages.flatMap((page) => page.items) ?? [];
  const names: ScopeNames = {};
  for (const connection of connections.data ?? [])
    names[`connection:${connection.id}`] = connection.email;
  for (const device of devices.data ?? []) names[`device:${device.id}`] = device.name;
  for (const computer of computers) names[`workspace:${computer.id}`] = computer.name;
  return {
    names,
    ready:
      (!needsConnections || connections.isSuccess) &&
      (!needsDevices || devices.isSuccess) &&
      (!needsWorkspaces || workspaces.isSuccess),
    error: connections.isError || devices.isError || workspaces.isError,
    connections: connections.data ?? [],
    devices: devices.data ?? [],
    workspaces: computers,
    more: workspaces.hasNextPage,
    fetchingMore: workspaces.isFetchingNextPage,
    loadMore: () => {
      if (!workspaces.isFetching) workspaces.fetchNextPage().catch(() => {});
    },
    refresh: () =>
      Promise.all([
        ...(needsConnections ? [connections.refetch()] : []),
        ...(needsDevices ? [devices.refetch()] : []),
        ...(needsWorkspaces ? [workspaces.refetch()] : []),
      ]),
  };
}
