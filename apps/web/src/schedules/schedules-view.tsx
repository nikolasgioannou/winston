import { useState } from "react";
import { Badge, Button } from "@winston/ui";
import type { Schedule } from "@winston/contracts/schedules";

export type SchedulesState = { kind: "loading" | "error" } | { kind: "ready"; items: Schedule[] };
export type ScheduleAction = "cancel" | "pause" | "resume";

export function SchedulesView({
  state,
  busy = false,
  pendingAction = null,
  failure = false,
  more = false,
  onRefresh,
  onMore,
  onCancel,
  onPause,
  onResume,
  onEdit,
  onHistory,
}: {
  state: SchedulesState;
  busy?: boolean;
  pendingAction?: ScheduleAction | null;
  failure?: boolean;
  more?: boolean;
  onRefresh: () => void;
  onMore: () => void;
  onCancel: (schedule: Schedule) => void;
  onPause: (schedule: Schedule) => void;
  onResume: (schedule: Schedule) => void;
  onEdit: (schedule: Schedule) => void;
  onHistory?: (schedule: Schedule) => void;
}) {
  const [confirmation, setConfirmation] = useState<Schedule | null>(null);
  return (
    <>
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-xl font-medium">Schedules</h1>
        <Button variant="quiet" disabled={busy} onClick={onRefresh}>
          Refresh
        </Button>
      </div>
      {state.kind === "loading" ? (
        <p role="status" className="text-sm text-muted">
          Loading schedules…
        </p>
      ) : null}
      {state.kind === "error" ? (
        <p role="alert" className="text-sm text-muted">
          Unable to load schedules. Refresh to try again.
        </p>
      ) : null}
      {pendingAction ? (
        <p role="status" className="text-sm text-muted">
          {pendingAction === "cancel"
            ? "Canceling schedule…"
            : pendingAction === "pause"
              ? "Pausing schedule…"
              : "Resuming schedule…"}
        </p>
      ) : null}
      {failure ? (
        <p role="alert" className="text-sm text-muted">
          Could not confirm the change. Refresh to check the current status.
        </p>
      ) : null}
      {state.kind === "ready" && state.items.length === 0 ? (
        <p className="text-sm text-muted">No schedules yet.</p>
      ) : null}
      {state.kind === "ready" ? (
        <div className="divide-y divide-line">
          {state.items.map((schedule) => (
            <section
              key={schedule.id}
              aria-label={schedule.objective}
              className="space-y-3 py-5 first:pt-0"
            >
              <h2 className="text-sm font-medium whitespace-pre-wrap wrap-anywhere">
                {schedule.objective}
              </h2>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <Badge tone={schedule.state === "active" ? "success" : "neutral"}>
                  {schedule.state === "active"
                    ? "Active"
                    : schedule.state === "paused"
                      ? "Paused"
                      : schedule.state === "canceled"
                        ? "Canceled"
                        : "No upcoming runs"}
                </Badge>
                <span className="text-xs text-muted">
                  {schedule.timing.kind === "once" ? "Once" : "Repeating"}
                </span>
              </div>
              <dl className="grid gap-1 text-sm text-muted">
                <div className="flex flex-wrap gap-x-2">
                  <dt>Next run</dt>
                  <dd>
                    {schedule.nextRunAt
                      ? new Intl.DateTimeFormat(undefined, {
                          dateStyle: "medium",
                          timeStyle: "short",
                          timeZone: schedule.timing.timezone,
                        }).format(new Date(schedule.nextRunAt))
                      : "None"}
                  </dd>
                </div>
                <div className="flex flex-wrap gap-x-2">
                  <dt>Timezone</dt>
                  <dd>{schedule.timing.timezone}</dd>
                </div>
              </dl>
              <div className="flex flex-wrap items-start gap-2 empty:hidden">
                {onHistory ? (
                  <Button
                    variant="quiet"
                    onClick={() => {
                      onHistory(schedule);
                    }}
                  >
                    History
                  </Button>
                ) : null}
                {confirmation?.id !== schedule.id && schedule.state !== "canceled" ? (
                  <Button
                    variant="quiet"
                    disabled={busy || failure}
                    onClick={() => {
                      onEdit(schedule);
                    }}
                  >
                    Edit
                  </Button>
                ) : null}
                {confirmation?.id !== schedule.id && schedule.state === "active" ? (
                  <Button
                    disabled={busy || failure}
                    variant="quiet"
                    onClick={() => {
                      onPause(schedule);
                    }}
                  >
                    Pause
                  </Button>
                ) : null}
                {confirmation?.id !== schedule.id && schedule.state === "paused" ? (
                  <Button
                    disabled={busy || failure}
                    variant="quiet"
                    onClick={() => {
                      onResume(schedule);
                    }}
                  >
                    Resume
                  </Button>
                ) : null}
                {schedule.state !== "canceled" ? (
                  confirmation?.id === schedule.id ? (
                    <div className="space-y-2">
                      <p className="text-sm">Cancel this schedule?</p>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          disabled={busy || failure}
                          onClick={() => {
                            onCancel(confirmation);
                            setConfirmation(null);
                          }}
                        >
                          Cancel schedule
                        </Button>
                        <Button
                          variant="quiet"
                          disabled={busy}
                          onClick={() => {
                            setConfirmation(null);
                          }}
                        >
                          Keep schedule
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button
                      disabled={busy || failure}
                      variant="quiet"
                      onClick={() => {
                        setConfirmation(schedule);
                      }}
                    >
                      Cancel
                    </Button>
                  )
                ) : null}
              </div>
            </section>
          ))}
        </div>
      ) : null}
      {more ? (
        <Button disabled={busy} onClick={onMore}>
          Load more
        </Button>
      ) : null}
    </>
  );
}
