import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Button } from "@winston/ui";
import {
  scheduleSchema,
  scheduleRunsSchema,
  type ScheduleRunCursor,
} from "@winston/contracts/schedules";
import { ownerJson } from "../management/api";
import { ScheduleRunsView } from "./runs-view";

export function ScheduleRuns({ id, onBack }: { id: string; onBack: () => void }) {
  const schedule = useQuery({
    queryKey: ["owner-schedule", id],
    queryFn: ({ signal }) => ownerJson(`/api/owner/schedules/${id}`, scheduleSchema, { signal }),
  });
  const runs = useInfiniteQuery({
    queryKey: ["schedule-runs", id],
    enabled: !!schedule.data && !schedule.isError,
    queryFn: ({ signal, pageParam }) => {
      const query = pageParam
        ? `?${new URLSearchParams({ beforeRevision: String(pageParam.revision), beforeDueAt: pageParam.dueAt }).toString()}`
        : "";
      return ownerJson(`/api/owner/schedules/${id}/runs${query}`, scheduleRunsSchema, { signal });
    },
    initialPageParam: null as ScheduleRunCursor | null,
    getNextPageParam: (page) => page.next,
  });
  function refresh() {
    Promise.all([schedule.refetch(), runs.refetch()]).catch(() => {});
  }
  if (schedule.isError)
    return (
      <>
        <h1 className="text-xl font-medium">Schedule history</h1>
        <p role="alert" className="text-sm text-muted">
          Unable to load this schedule.
        </p>
        <div className="flex gap-2">
          <Button disabled={schedule.isFetching} onClick={refresh}>
            Try again
          </Button>
          <Button variant="quiet" onClick={onBack}>
            Back to schedules
          </Button>
        </div>
      </>
    );
  if (!schedule.data)
    return (
      <p role="status" className="text-sm text-muted">
        Loading schedule…
      </p>
    );
  return (
    <ScheduleRunsView
      schedule={schedule.data}
      state={
        runs.isError
          ? { kind: "error" }
          : runs.data
            ? { kind: "ready", items: runs.data.pages.flatMap((page) => page.items) }
            : { kind: "loading" }
      }
      busy={schedule.isFetching || runs.isFetching}
      more={runs.hasNextPage}
      onBack={onBack}
      onRefresh={refresh}
      onMore={() => {
        if (!runs.isFetching) runs.fetchNextPage().catch(() => {});
      }}
    />
  );
}
