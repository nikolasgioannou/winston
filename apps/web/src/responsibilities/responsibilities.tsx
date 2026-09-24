import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  responsibilityListSchema,
  responsibilitySchema,
  type Responsibility,
} from "@winston/contracts/responsibilities";
import { connectionListSchema } from "@winston/contracts/connections";
import { registeredDeviceListSchema } from "@winston/contracts/device-registry";
import { ownerJson } from "../management/api";
import { ResponsibilitiesView, type ResponsibilityAction } from "./responsibilities-view";
import type { ScopeNames } from "./scope";

const key = ["owner-responsibilities"] as const;
export function Responsibilities() {
  const client = useQueryClient();
  const list = useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam, signal }) =>
      ownerJson(
        `/api/owner/responsibilities${pageParam ? `?after=${pageParam}` : ""}`,
        responsibilityListSchema,
        { signal },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next,
  });
  const items = list.data?.pages.flatMap((page) => page.items) ?? [];
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
  const change = useMutation({
    mutationFn: ({ item, action }: { item: Responsibility; action: ResponsibilityAction }) =>
      ownerJson(`/api/owner/responsibilities/${item.id}/${action}`, responsibilitySchema, {
        method: "POST",
        body: { revision: item.revision },
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: key });
    },
  });
  return (
    <ResponsibilitiesView
      state={
        list.isError
          ? { kind: "error" }
          : list.data
            ? { kind: "ready", items }
            : { kind: "loading" }
      }
      names={names}
      namesReady={
        (!needsConnections || connections.isSuccess) && (!needsDevices || devices.isSuccess)
      }
      busy={list.isFetching || change.isPending}
      pending={change.isPending}
      failure={change.isError}
      more={list.hasNextPage}
      onRefresh={() => {
        Promise.all([
          list.refetch(),
          ...(needsConnections ? [connections.refetch()] : []),
          ...(needsDevices ? [devices.refetch()] : []),
        ])
          .then(([result]) => {
            if (result.isSuccess) change.reset();
          })
          .catch(() => {});
      }}
      onMore={() => {
        if (!list.isFetching) list.fetchNextPage().catch(() => {});
      }}
      onChange={(item, action) => {
        change.mutate({ item, action });
      }}
    />
  );
}
