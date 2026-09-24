import { useInfiniteQuery } from "@tanstack/react-query";
import { taskActionEvidenceSchema } from "@winston/contracts/tasks";
import { ownerJson } from "../management/api";
import { useResourceCatalog } from "../management/use-resource-catalog";
import { ActionEvidenceView } from "./action-evidence-view";

export function ActionEvidence({ id, stopped }: { id: string; stopped: boolean }) {
  const query = useInfiniteQuery({
    queryKey: ["owner-task-actions", id],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      ownerJson(
        `/api/owner/activity/${id}/actions${pageParam ? `?after=${pageParam}` : ""}`,
        taskActionEvidenceSchema,
        { signal },
      ),
    getNextPageParam: (page) => page.next,
  });
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const catalog = useResourceCatalog({
    connections: items.some((item) => item.authorization.target.kind === "connection"),
    devices: items.some((item) => item.authorization.target.kind === "device"),
    workspaces: items.some((item) => item.authorization.target.kind === "workspace"),
  });
  return (
    <ActionEvidenceView
      state={
        query.isError
          ? { kind: "error" }
          : query.data
            ? {
                kind: "ready",
                value: { items, unresolved: query.data.pages.at(-1)?.unresolved ?? 0, next: null },
              }
            : { kind: "loading" }
      }
      names={catalog.names}
      stopped={stopped}
      checkedAt={query.dataUpdatedAt}
      more={query.hasNextPage}
      busy={query.isFetching}
      onMore={() => {
        if (!query.isFetching) query.fetchNextPage().catch(() => {});
      }}
    />
  );
}
