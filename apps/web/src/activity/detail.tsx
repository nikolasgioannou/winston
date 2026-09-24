import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { taskDetailSchema, taskHistorySchema } from "@winston/contracts/tasks";
import { ownerJson } from "../management/api";
import { TaskDetailView } from "./detail-view";

export function TaskDetailPage({ id }: { id: string }) {
  const detail = useQuery({
    queryKey: ["owner-task-detail", id],
    queryFn: ({ signal }) => ownerJson(`/api/owner/activity/${id}`, taskDetailSchema, { signal }),
  });
  const history = useInfiniteQuery({
    queryKey: ["owner-task-history", id],
    enabled: !!detail.data && !detail.isError,
    initialPageParam: null as number | null,
    queryFn: ({ signal, pageParam }) =>
      ownerJson(
        `/api/owner/activity/${id}/history${pageParam === null ? "" : `?beforeRevision=${String(pageParam)}`}`,
        taskHistorySchema,
        { signal },
      ),
    getNextPageParam: (page) => page.next,
  });

  return (
    <TaskDetailView
      state={
        detail.isError
          ? { kind: "error" }
          : detail.data
            ? { kind: "ready", value: detail.data }
            : { kind: "loading" }
      }
      history={
        history.isError
          ? { kind: "error" }
          : history.data
            ? { kind: "ready", items: history.data.pages.flatMap((page) => page.items) }
            : { kind: "loading" }
      }
      busy={detail.isFetching || history.isFetching}
      more={history.hasNextPage}
      onRefresh={() => {
        Promise.all([detail.refetch(), history.refetch()]).catch(() => {});
      }}
      onMore={() => {
        if (!history.isFetching) history.fetchNextPage().catch(() => {});
      }}
    />
  );
}
