import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import { scheduleListSchema, scheduleSchema, type Schedule } from "@winston/contracts/schedules";
import { ownerJson } from "../management/api";
import { SchedulesView } from "./schedules-view";

const key = ["owner-schedules"] as const;
type Page = ReturnType<typeof scheduleListSchema.parse>;

export function Schedules() {
  const client = useQueryClient();
  const list = useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam, signal }) =>
      ownerJson(
        `/api/owner/schedules${pageParam ? `?after=${pageParam}` : ""}`,
        scheduleListSchema,
        { signal },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next,
  });
  const cancellation = useMutation({
    mutationFn: (schedule: Schedule) =>
      ownerJson(`/api/owner/schedules/${schedule.id}/cancel`, scheduleSchema, {
        method: "POST",
        body: { revision: schedule.revision },
      }),
    onSuccess: async (receipt) => {
      await client.cancelQueries({ queryKey: key });
      client.setQueryData<InfiniteData<Page, string | null>>(key, (previous) =>
        previous
          ? {
              ...previous,
              pages: previous.pages.map((page) => ({
                ...page,
                items: page.items.map((item) =>
                  item.id === receipt.id && item.revision <= receipt.revision ? receipt : item,
                ),
              })),
            }
          : previous,
      );
      await client.invalidateQueries({ queryKey: key });
    },
  });
  return (
    <SchedulesView
      state={
        list.isError
          ? { kind: "error" }
          : list.data
            ? {
                kind: "ready",
                items: list.data.pages.flatMap((page) => page.items),
              }
            : { kind: "loading" }
      }
      busy={list.isFetching || cancellation.isPending}
      canceling={cancellation.isPending}
      failure={cancellation.isError}
      more={list.hasNextPage}
      onRefresh={() => {
        list
          .refetch()
          .then((result) => {
            if (result.isSuccess) cancellation.reset();
          })
          .catch(() => {});
      }}
      onMore={() => {
        if (!list.isFetching) list.fetchNextPage().catch(() => {});
      }}
      onCancel={(schedule) => {
        cancellation.mutate(schedule);
      }}
    />
  );
}
