import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  responsibilityListSchema,
  responsibilitySchema,
  type Responsibility,
} from "@winston/contracts/responsibilities";
import { ownerJson } from "../management/api";
import { ResponsibilitiesView, type ResponsibilityAction } from "./responsibilities-view";
import { useScopeNames } from "./use-scope-names";

const key = ["owner-responsibilities"] as const;
export function Responsibilities() {
  const client = useQueryClient();
  const navigate = useNavigate();
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
  const scope = useScopeNames(items);
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
      names={scope.names}
      namesReady={scope.ready}
      onInspect={(id) => {
        navigate({ to: "/responsibilities/$id", params: { id } }).catch(() => {
          window.location.assign(`/responsibilities/${id}`);
        });
      }}
      busy={list.isFetching || change.isPending}
      pending={change.isPending}
      failure={change.isError}
      more={list.hasNextPage}
      onRefresh={() => {
        Promise.all([list.refetch(), scope.refresh()])
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
