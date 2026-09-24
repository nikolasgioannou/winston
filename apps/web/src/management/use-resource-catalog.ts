import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { connectionListSchema } from "@winston/contracts/connections";
import { registeredDeviceListSchema } from "@winston/contracts/device-registry";
import { ownerJson } from "./api";
import { workspaceListSchema } from "@winston/contracts/workspace";

export function useResourceCatalog({
  connections: needsConnections = true,
  devices: needsDevices = true,
  workspaces: needsWorkspaces = true,
} = {}) {
  const connections = useQuery({
    queryKey: ["owner-connections"],
    enabled: needsConnections,
    queryFn: ({ signal }) => ownerJson("/api/owner/connections", connectionListSchema, { signal }),
  });
  const devices = useQuery({
    queryKey: ["owner-devices"],
    enabled: needsDevices,
    queryFn: ({ signal }) =>
      ownerJson("/api/owner/devices", registeredDeviceListSchema, { signal }),
  });
  const workspaces = useInfiniteQuery({
    queryKey: ["owner-workspaces"],
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
  const names: Record<string, string> = {};
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
    fetching: connections.isFetching || devices.isFetching || workspaces.isFetching,
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
