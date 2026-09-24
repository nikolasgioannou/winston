import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import { scheduleListSchema, scheduleSchema, type Schedule } from "@winston/contracts/schedules";
import { ownerJson } from "../management/api";
import { SchedulesView, type ScheduleAction } from "./schedules-view";
import { useNavigate } from "@tanstack/react-router";

const key = ["owner-schedules"] as const;
type Page = ReturnType<typeof scheduleListSchema.parse>;

export function Schedules() {
  const navigate = useNavigate();
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
  const change = useMutation({
    mutationFn: ({ schedule, action }: { schedule: Schedule; action: ScheduleAction }) =>
      ownerJson(`/api/owner/schedules/${schedule.id}/${action}`, scheduleSchema, {
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
      busy={list.isFetching || change.isPending}
      pendingAction={change.isPending ? change.variables.action : null}
      failure={change.isError}
      more={list.hasNextPage}
      onRefresh={() => {
        list
          .refetch()
          .then((result) => {
            if (result.isSuccess) change.reset();
          })
          .catch(() => {});
      }}
      onMore={() => {
        if (!list.isFetching) list.fetchNextPage().catch(() => {});
      }}
      onCancel={(schedule) => {
        change.mutate({ schedule, action: "cancel" });
      }}
      onPause={(schedule) => {
        change.mutate({ schedule, action: "pause" });
      }}
      onResume={(schedule) => {
        change.mutate({ schedule, action: "resume" });
      }}
      onEdit={(schedule) => {
        navigate({ to: "/schedules/$id", params: { id: schedule.id } }).catch(() => {
          window.location.assign(`/schedules/${schedule.id}`);
        });
      }}
      onHistory={(schedule) => {
        navigate({ to: "/schedules/$id/runs", params: { id: schedule.id } }).catch(() => {
          window.location.assign(`/schedules/${schedule.id}/runs`);
        });
      }}
    />
  );
}
