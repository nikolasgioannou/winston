import type { TaskDetail } from "@winston/contracts/tasks";
import { Badge, Button } from "@winston/ui";
import type { ActivityState } from "./activity-view";

export type TaskDetailState = { kind: "loading" | "error" } | { kind: "ready"; value: TaskDetail };
const labels = {
  queued: "Queued",
  running: "Running",
  waiting: "Waiting",
  succeeded: "Completed",
  failed: "Failed",
  canceled: "Canceled",
};
function timestamp(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}

export function TaskDetailView({
  state,
  history,
  busy = false,
  more = false,
  onRefresh,
  onMore,
}: {
  state: TaskDetailState;
  history: ActivityState;
  busy?: boolean;
  more?: boolean;
  onRefresh: () => void;
  onMore: () => void;
}) {
  return (
    <>
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-xl font-medium">Request</h1>
        <Button variant="quiet" disabled={busy} onClick={onRefresh}>
          Refresh
        </Button>
      </div>
      {state.kind === "loading" ? (
        <p role="status" className="text-sm text-muted">
          Loading request…
        </p>
      ) : null}
      {state.kind === "error" ? (
        <p role="alert" className="text-sm text-muted">
          Unable to load this request. Refresh to try again.
        </p>
      ) : null}
      {state.kind === "ready" ? (
        <>
          <section aria-label="Current request" className="space-y-4">
            <Badge
              tone={
                state.value.state === "failed"
                  ? "error"
                  : state.value.state === "succeeded"
                    ? "success"
                    : "neutral"
              }
            >
              {labels[state.value.state]}
            </Badge>
            <p className="text-sm whitespace-pre-wrap wrap-anywhere">{state.value.objective}</p>
            <dl className="space-y-1 text-xs text-muted">
              <div className="flex flex-wrap gap-x-2">
                <dt>Created</dt>
                <dd>
                  <time dateTime={state.value.createdAt}>{timestamp(state.value.createdAt)}</time>
                </dd>
              </div>
              <div className="flex flex-wrap gap-x-2">
                <dt>Updated</dt>
                <dd>
                  <time dateTime={state.value.updatedAt}>{timestamp(state.value.updatedAt)}</time>
                </dd>
              </div>
            </dl>
            {state.value.waiting ? (
              <p className="text-sm whitespace-pre-wrap wrap-anywhere">
                {state.value.waiting.detail}
              </p>
            ) : null}
            {state.value.result ? (
              <p className="text-sm whitespace-pre-wrap wrap-anywhere">{state.value.result}</p>
            ) : null}
          </section>
          <section aria-label="Request history" className="space-y-4 border-t border-line pt-6">
            <h2 className="text-sm font-medium">History</h2>
            {history.kind === "loading" ? (
              <p role="status" className="text-sm text-muted">
                Loading history…
              </p>
            ) : null}
            {history.kind === "error" ? (
              <p role="alert" className="text-sm text-muted">
                Unable to load history. Refresh to try again.
              </p>
            ) : null}
            {history.kind === "ready" && history.items.length === 0 ? (
              <p className="text-sm text-muted">No recorded revisions.</p>
            ) : null}
            {history.kind === "ready" ? (
              <div className="divide-y divide-line">
                {history.items.map((item) => (
                  <details key={item.revision} className="py-3 first:pt-0">
                    <summary className="cursor-pointer rounded-sm text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
                      {labels[item.state]} ·{" "}
                      <time dateTime={item.updatedAt}>{timestamp(item.updatedAt)}</time> · Revision{" "}
                      {item.revision}
                    </summary>
                    <div className="space-y-2 pt-3 text-sm whitespace-pre-wrap wrap-anywhere">
                      <p>{item.objective}</p>
                      {item.objectiveTruncated ? (
                        <p className="text-xs text-muted">Request excerpt</p>
                      ) : null}
                      {item.waiting ? <p>{item.waiting.detail}</p> : null}
                      {item.result ? <p>{item.result}</p> : null}
                      {item.resultTruncated ? (
                        <p className="text-xs text-muted">Result excerpt</p>
                      ) : null}
                    </div>
                  </details>
                ))}
              </div>
            ) : null}
            {more && history.kind === "ready" ? (
              <Button disabled={busy} onClick={onMore}>
                Earlier revisions
              </Button>
            ) : null}
          </section>
        </>
      ) : null}
      <a
        href="/activity"
        className="text-sm text-muted underline underline-offset-4 hover:text-ink"
      >
        Back to activity
      </a>
    </>
  );
}
