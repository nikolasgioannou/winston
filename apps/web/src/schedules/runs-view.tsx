import { Badge, Button } from "@winston/ui";
import type { Schedule, ScheduleRuns } from "@winston/contracts/schedules";

export type RunsState =
  { kind: "loading" | "error" } | { kind: "ready"; items: ScheduleRuns["items"] };
const labels = {
  queued: "Scheduled",
  running: "Running",
  waiting: "Waiting",
  succeeded: "Completed",
  failed: "Failed",
  canceled: "Canceled",
};

export function ScheduleRunsView({
  schedule,
  state,
  busy = false,
  more = false,
  onRefresh,
  onMore,
  onBack,
}: {
  schedule: Schedule;
  state: RunsState;
  busy?: boolean;
  more?: boolean;
  onRefresh: () => void;
  onMore: () => void;
  onBack: () => void;
}) {
  const format = (value: string) =>
    new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: schedule.timing.timezone,
    }).format(new Date(value));
  return (
    <>
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-xl font-medium">Schedule history</h1>
        <Button variant="quiet" disabled={busy} onClick={onRefresh}>
          Refresh
        </Button>
      </div>
      <section className="space-y-3" aria-label="Schedule">
        <h2 className="text-sm font-medium whitespace-pre-wrap wrap-anywhere">
          {schedule.objective}
        </h2>
        <dl className="space-y-1 text-sm text-muted">
          <div className="flex flex-wrap gap-x-2">
            <dt>Next run</dt>
            <dd>{schedule.nextRunAt ? format(schedule.nextRunAt) : "None"}</dd>
          </div>
          <div className="flex flex-wrap gap-x-2">
            <dt>Timezone</dt>
            <dd>{schedule.timing.timezone}</dd>
          </div>
        </dl>
        {schedule.responsibility ? (
          <a
            className="text-sm text-muted underline underline-offset-4 hover:text-ink"
            href={`/responsibilities/${schedule.responsibility.id}`}
          >
            View responsibility
          </a>
        ) : null}
      </section>
      {state.kind === "loading" ? (
        <p role="status" className="text-sm text-muted">
          Loading runs…
        </p>
      ) : null}
      {state.kind === "error" ? (
        <p role="alert" className="text-sm text-muted">
          Unable to load runs. Refresh to try again.
        </p>
      ) : null}
      {state.kind === "ready" && state.items.length === 0 ? (
        <p className="text-sm text-muted">No runs yet.</p>
      ) : null}
      {state.kind === "ready" ? (
        <div className="divide-y divide-line">
          {state.items.map((run) => (
            <article
              key={run.taskId}
              aria-label={`${labels[run.state]} run`}
              className="space-y-2 py-5 first:pt-0"
            >
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <Badge
                  tone={
                    run.state === "failed"
                      ? "error"
                      : run.state === "succeeded"
                        ? "success"
                        : "neutral"
                  }
                >
                  {labels[run.state]}
                </Badge>
                <time dateTime={run.dueAt} className="text-xs text-muted">
                  {format(run.dueAt)}
                </time>
              </div>
              {run.waiting ? (
                <p className="text-sm whitespace-pre-wrap wrap-anywhere">{run.waiting.detail}</p>
              ) : null}
              {run.result ? (
                <p className="text-sm whitespace-pre-wrap wrap-anywhere">{run.result}</p>
              ) : null}
              {run.truncated ? <p className="text-xs text-muted">Result excerpt</p> : null}
            </article>
          ))}
        </div>
      ) : null}
      {more && state.kind === "ready" ? (
        <Button disabled={busy} onClick={onMore}>
          Older runs
        </Button>
      ) : null}
      <div>
        <Button variant="quiet" onClick={onBack}>
          Back to schedules
        </Button>
      </div>
    </>
  );
}
