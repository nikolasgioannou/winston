import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  authorizationRulesSchema,
  authorizationReceiptSchema,
  type AuthorizationUpdate,
} from "@winston/contracts/authorization";
import { ownerJson } from "../management/api";
import { useResourceCatalog } from "../management/use-resource-catalog";
import { resourceOptions } from "../management/resource-options";
import { PermissionsView } from "./permissions-view";

export function Permissions() {
  const [version, setVersion] = useState(0);
  const catalog = useResourceCatalog();
  const rules = useQuery({
    queryKey: ["owner-permissions"],
    queryFn: ({ signal }) =>
      ownerJson("/api/owner/permissions", authorizationRulesSchema, { signal }),
  });
  const change = useMutation({
    mutationFn: (input: AuthorizationUpdate) =>
      ownerJson("/api/owner/permissions", authorizationReceiptSchema, {
        method: "PUT",
        body: input,
      }),
    onSuccess: async () => {
      await rules.refetch();
      setVersion((current) => current + 1);
    },
  });
  const choices = resourceOptions(catalog.connections, catalog.devices, catalog.workspaces).map(
    (choice) =>
      choice.operations.includes("calendar.list")
        ? {
            ...choice,
            label: `${choice.label} · All calendars`,
            operations: ["calendar.list", "calendar.read", "calendar.write"] as const,
          }
        : choice,
  );
  return (
    <PermissionsView
      version={version}
      state={
        catalog.error || rules.isError
          ? { kind: "error" }
          : catalog.ready && rules.data
            ? {
                kind: "ready",
                choices: choices.map((choice) => ({
                  ...choice,
                  operations: [...choice.operations],
                })),
                rules: rules.data,
              }
            : { kind: "loading" }
      }
      busy={catalog.fetching || rules.isFetching || change.isPending}
      failed={change.isError}
      more={catalog.more}
      onMore={catalog.loadMore}
      onSave={(input) => {
        change.mutate(input);
      }}
      onRefresh={() => {
        Promise.all([rules.refetch(), catalog.refresh()])
          .then(([result, resources]) => {
            if (result.isSuccess && resources.every((resource) => resource.isSuccess)) {
              change.reset();
              setVersion((current) => current + 1);
            }
          })
          .catch(() => {});
      }}
    />
  );
}
