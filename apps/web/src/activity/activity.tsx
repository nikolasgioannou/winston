import { useInfiniteQuery } from "@tanstack/react-query";
import { taskActivitySchema, type TaskActivityCursor } from "@winston/contracts/tasks";
import { ownerJson } from "../management/api";
import { ActivityView } from "./activity-view";

export function ActivityPage() {
  const activity = useInfiniteQuery({
    queryKey: ["owner-activity"],
    queryFn: ({ signal, pageParam }) => {
      const query = pageParam
        ? `?${new URLSearchParams({ beforeCreatedAt: pageParam.createdAt, beforeId: pageParam.id }).toString()}`
        : "";
      return ownerJson(`/api/owner/activity${query}`, taskActivitySchema, { signal });
    },
    initialPageParam: null as TaskActivityCursor | null,
    getNextPageParam: (page) => page.next,
  });

  return (
    <ActivityView
      state={
        activity.isError
          ? { kind: "error" }
          : activity.data
            ? { kind: "ready", items: activity.data.pages.flatMap((page) => page.items) }
            : { kind: "loading" }
      }
      busy={activity.isFetching}
      more={activity.hasNextPage}
      onRefresh={() => {
        activity.refetch().catch(() => {});
      }}
      onMore={() => {
        if (!activity.isFetching) activity.fetchNextPage().catch(() => {});
      }}
    />
  );
}
