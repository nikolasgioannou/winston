import { useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  registeredDeviceListSchema,
  registeredDeviceSchema,
} from "@winston/contracts/device-registry";
import { workspaceListSchema } from "@winston/contracts/workspace";
import { ownerJson } from "../management/api";
import { ComputersView } from "./computers-view";
import type { DeviceChange } from "./device-card";

export function Computers() {
  const client = useQueryClient();
  const [version, setVersion] = useState(0);
  const devices = useQuery({
    queryKey: ["owner-devices"],
    queryFn: ({ signal }) =>
      ownerJson("/api/owner/devices", registeredDeviceListSchema, { signal }),
  });
  const workspaces = useInfiniteQuery({
    queryKey: ["owner-workspaces"],
    queryFn: ({ signal, pageParam }) =>
      ownerJson(
        `/api/owner/workspaces${pageParam ? `?after=${pageParam}` : ""}`,
        workspaceListSchema,
        { signal },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next,
  });
  const change = useMutation({
    mutationFn: (input: DeviceChange) =>
      ownerJson(
        `/api/owner/devices/${input.device.id}${input.action === "rename" ? "" : `/${input.action}`}`,
        registeredDeviceSchema,
        {
          method: input.action === "rename" ? "PATCH" : "POST",
          body: {
            revision: input.device.revision,
            ...(input.action === "rename" ? { name: input.name } : {}),
          },
        },
      ),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["owner-devices"] });
      await client.invalidateQueries({ queryKey: ["responsibility-device-names"] });
      setVersion((current) => current + 1);
    },
  });
  return (
    <ComputersView
      key={version}
      state={
        devices.isError || workspaces.isError
          ? { kind: "error" }
          : devices.data && workspaces.data
            ? {
                kind: "ready",
                devices: devices.data,
                workspaces: workspaces.data.pages.flatMap((page) => page.items),
              }
            : { kind: "loading" }
      }
      busy={devices.isFetching || workspaces.isFetching || change.isPending}
      saving={change.isPending}
      failed={change.isError}
      more={workspaces.hasNextPage}
      onRefresh={() => {
        Promise.all([devices.refetch(), workspaces.refetch()])
          .then((results) => {
            if (results.every((result) => result.isSuccess)) {
              change.reset();
              setVersion((current) => current + 1);
            }
          })
          .catch(() => {});
      }}
      onMore={() => {
        if (!workspaces.isFetching) workspaces.fetchNextPage().catch(() => {});
      }}
      onChange={(input) => {
        change.mutate(input);
      }}
    />
  );
}
