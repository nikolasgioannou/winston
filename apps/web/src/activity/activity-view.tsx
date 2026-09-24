import type { TaskActivity } from "@winston/contracts/tasks";
import { Badge, Button } from "@winston/ui";

export type ActivityItems = TaskActivity["items"];
export type ActivityState = { kind: "loading" | "error" } | { kind: "ready"; items: ActivityItems };

const labels = {
  queued: "Queued",
  running: "Running",
  waiting: "Waiting",
  succeeded: "Completed",
  failed: "Failed",
  canceled: "Canceled",
};

export function ActivityView({
  state,
  busy = false,
  more = false,
  onRefresh,
  onMore,
}: {
  state: ActivityState;
  busy?: boolean;
  more?: boolean;
  onRefresh: () => void;
  onMore: () => void;
}) {
  const format = (value: string) =>
    new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));

  return (
    <>
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-xl font-medium">Activity</h1>
        <Button variant="quiet" disabled={busy} onClick={onRefresh}>
          Refresh
        </Button>
      </div>
      {state.kind === "loading" ? (
        <p role="status" className="text-sm text-muted">
          Loading activity…
        </p>
      ) : null}
      {state.kind === "error" ? (
        <p role="alert" className="text-sm text-muted">
          Unable to load activity. Refresh to try again.
        </p>
      ) : null}
      {state.kind === "ready" && state.items.length === 0 ? (
        <p className="text-sm text-muted">No requests yet.</p>
      ) : null}
      {state.kind === "ready" ? (
        <div className="divide-y divide-line">
          {state.items.map((item) => (
            <article
              key={item.id}
              aria-label={`${labels[item.state]} request`}
              className="space-y-3 py-5 first:pt-0"
            >
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <Badge
                  tone={
                    item.state === "failed"
                      ? "error"
                      : item.state === "succeeded"
                        ? "success"
                        : "neutral"
                  }
                >
                  {labels[item.state]}
                </Badge>
                <time dateTime={item.createdAt} className="text-xs text-muted">
                  {format(item.createdAt)}
                </time>
              </div>
              <h2 className="text-sm font-medium whitespace-pre-wrap wrap-anywhere">
                <a href={`/activity/${item.id}`} className="hover:underline underline-offset-4">
                  {item.objective}
                </a>
              </h2>
              {item.objectiveTruncated ? (
                <p className="text-xs text-muted">Request excerpt</p>
              ) : null}
              {item.waiting ? (
                <p className="text-sm whitespace-pre-wrap wrap-anywhere">{item.waiting.detail}</p>
              ) : null}
              {item.result ? (
                <p className="text-sm whitespace-pre-wrap wrap-anywhere">{item.result}</p>
              ) : null}
              {item.resultTruncated ? <p className="text-xs text-muted">Result excerpt</p> : null}
              {item.updatedAt !== item.createdAt ? (
                <p className="text-xs text-muted">
                  Updated <time dateTime={item.updatedAt}>{format(item.updatedAt)}</time>
                </p>
              ) : null}
            </article>
          ))}
        </div>
      ) : null}
      {more && state.kind === "ready" ? (
        <Button disabled={busy} onClick={onMore}>
          Older requests
        </Button>
      ) : null}
    </>
  );
}
