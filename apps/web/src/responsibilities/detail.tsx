import { useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  responsibilitySchema,
  responsibilitySourcesSchema,
  responsibilityHistorySchema,
  type Responsibility,
} from "@winston/contracts/responsibilities";
import { ownerJson } from "../management/api";
import { ResponsibilityDetailView } from "./detail-view";
import { useScopeNames } from "./use-scope-names";
import type { ResponsibilityEdit } from "./editor-view";
import type { ResponsibilityAction } from "./responsibilities-view";
import { resourceOptions } from "../management/resource-options";

export function ResponsibilityDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const client = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [version, setVersion] = useState(0);
  const query = useQuery({
    queryKey: ["owner-responsibility", id],
    queryFn: ({ signal }) =>
      ownerJson(`/api/owner/responsibilities/${id}`, responsibilitySchema, { signal }),
  });
  const sources = useQuery({
    queryKey: ["responsibility-sources", id, query.data?.revision],
    enabled: !!query.data,
    queryFn: ({ signal }) =>
      ownerJson(`/api/owner/responsibilities/${id}/sources`, responsibilitySourcesSchema, {
        signal,
      }),
  });
  const history = useInfiniteQuery({
    queryKey: ["responsibility-history", id, query.data?.revision],
    enabled: !!query.data,
    queryFn: ({ pageParam, signal }) =>
      ownerJson(
        `/api/owner/responsibilities/${id}/history${pageParam === null ? "" : `?before=${String(pageParam)}`}`,
        responsibilityHistorySchema,
        { signal },
      ),
    initialPageParam: null as number | null,
    getNextPageParam: (page) => page.next,
  });
  const scope = useScopeNames(
    [
      ...(query.data ? [query.data] : []),
      ...(history.data?.pages.flatMap((page) => page.items) ?? []),
    ],
    editing,
  );
  const change = useMutation({
    mutationFn: (
      request:
        { action: ResponsibilityAction; item: Responsibility } | { edit: ResponsibilityEdit },
    ) =>
      "edit" in request
        ? ownerJson(`/api/owner/responsibilities/${id}`, responsibilitySchema, {
            method: "PUT",
            body: request.edit,
          })
        : ownerJson(`/api/owner/responsibilities/${id}/${request.action}`, responsibilitySchema, {
            method: "POST",
            body: { revision: request.item.revision },
          }),
    onSuccess: async (receipt) => {
      await client.cancelQueries({ queryKey: ["owner-responsibility", id] });
      client.setQueryData(["owner-responsibility", id], receipt);
      await client.invalidateQueries({ queryKey: ["owner-responsibilities"] });
      setEditing(false);
      setVersion((current) => current + 1);
    },
  });
  return (
    <ResponsibilityDetailView
      key={`${id}:${String(version)}`}
      state={
        query.isError
          ? { kind: "error" }
          : query.data
            ? { kind: "ready", value: query.data }
            : { kind: "loading" }
      }
      sources={
        sources.isError || (sources.data && sources.data.revision !== query.data?.revision)
          ? { kind: "error" }
          : sources.data
            ? { kind: "ready", value: sources.data }
            : { kind: "loading" }
      }
      history={
        history.isError
          ? { kind: "error" }
          : history.data
            ? {
                kind: "ready",
                value: { items: history.data.pages.flatMap((page) => page.items), next: null },
              }
            : { kind: "loading" }
      }
      names={scope.names}
      namesReady={scope.ready}
      busy={
        query.isFetching || change.isPending || history.isFetchingNextPage || scope.fetchingMore
      }
      catalog={
        scope.error
          ? { kind: "error" }
          : scope.ready
            ? {
                kind: "ready",
                items: resourceOptions(scope.connections, scope.devices, scope.workspaces),
              }
            : { kind: "loading" }
      }
      moreComputers={scope.more}
      onMoreComputers={scope.loadMore}
      onReloadChoices={() => {
        scope.refresh().catch(() => {});
      }}
      failed={change.isError}
      editing={editing}
      more={history.hasNextPage}
      onBack={onBack}
      onEdit={setEditing}
      onSave={(edit) => {
        change.mutate({ edit });
      }}
      onChange={(item, action) => {
        change.mutate({ item, action });
      }}
      onMore={() => {
        if (!history.isFetching) history.fetchNextPage().catch(() => {});
      }}
      onRefresh={() => {
        Promise.all([query.refetch(), sources.refetch(), history.refetch(), scope.refresh()])
          .then(([result]) => {
            if (result.isSuccess) {
              change.reset();
              setVersion((current) => current + 1);
            }
          })
          .catch(() => {});
      }}
    />
  );
}
