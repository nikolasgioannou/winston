import { Button } from "@winston/ui";
import type {
  responsibilityHistorySchema,
  responsibilitySourcesSchema,
} from "@winston/contracts/responsibilities";
import { ResponsibilityScope, type ScopeNames } from "./scope";

export type EvidenceState<T> = { kind: "loading" | "error" } | { kind: "ready"; value: T };
export type Sources = ReturnType<typeof responsibilitySourcesSchema.parse>;
export type History = ReturnType<typeof responsibilityHistorySchema.parse>;

function date(instant: string, timeZone?: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(instant));
}

export function ResponsibilityEvidence({
  sources,
  history,
  names,
  more,
  busy,
  onMore,
  onRetry,
}: {
  sources: EvidenceState<Sources>;
  history: EvidenceState<History>;
  names: ScopeNames;
  more: boolean;
  busy: boolean;
  onMore: () => void;
  onRetry: () => void;
}) {
  return (
    <>
      <section aria-label="Source instructions" className="space-y-3 border-t border-line pt-5">
        <h2 className="text-sm font-medium">Source instructions</h2>
        {sources.kind === "loading" ? (
          <p role="status" className="text-sm text-muted">
            Loading instructions…
          </p>
        ) : null}
        {sources.kind === "error" ? (
          <p role="alert" className="text-sm text-muted">
            Unable to load source instructions.
          </p>
        ) : null}
        {sources.kind === "ready" && !sources.value.items.length ? (
          <p className="text-sm text-muted">No linked message.</p>
        ) : null}
        {sources.kind === "ready"
          ? sources.value.items.map((source) => (
              <div key={source.messageId} className="space-y-2 text-sm">
                {source.status !== "current" ? (
                  <p className="text-muted">
                    {source.status === "changed"
                      ? "This message changed after the proposal. Its original wording is unavailable."
                      : "This source message is unavailable."}
                  </p>
                ) : (
                  <>
                    <p className="text-xs text-muted">
                      Telegram · {date(source.sentAt.instant, source.sentAt.timezone)} ·{" "}
                      {source.sentAt.timezone}
                    </p>
                    {source.text ? (
                      <blockquote className="whitespace-pre-wrap wrap-anywhere">
                        {source.text}
                      </blockquote>
                    ) : null}
                    {source.transcript !== null ? (
                      <div className="space-y-1">
                        <p className="text-xs text-muted">Voice transcript</p>
                        <blockquote className="whitespace-pre-wrap wrap-anywhere">
                          {source.transcript}
                        </blockquote>
                      </div>
                    ) : null}
                    {!source.text && source.transcript === null ? (
                      <p className="text-muted">
                        {source.kind === "voice"
                          ? "Voice note; transcript unavailable."
                          : "Attachment without a caption."}
                      </p>
                    ) : null}
                    {source.truncated ? <p className="text-xs text-muted">Excerpt</p> : null}
                  </>
                )}
              </div>
            ))
          : null}
      </section>
      <section aria-label="Change history" className="space-y-3 border-t border-line pt-5">
        <h2 className="text-sm font-medium">Change history</h2>
        {history.kind === "loading" ? (
          <p role="status" className="text-sm text-muted">
            Loading history…
          </p>
        ) : null}
        {history.kind === "error" ? (
          <p role="alert" className="text-sm text-muted">
            Unable to load change history.
          </p>
        ) : null}
        {history.kind === "ready"
          ? history.value.items.map((item) => (
              <details key={item.revision} className="space-y-3 text-sm">
                <summary className="cursor-pointer rounded-sm text-muted focus-visible:outline-2 focus-visible:outline-focus">
                  {item.state === "active"
                    ? "Agreed"
                    : item.state === "proposed"
                      ? "Proposed"
                      : item.state === "paused"
                        ? "Paused"
                        : "Ended"}{" "}
                  · {date(item.updatedAt)}
                </summary>
                <p className="whitespace-pre-wrap wrap-anywhere">{item.purpose}</p>
                <ResponsibilityScope scope={item.scope} names={names} />
              </details>
            ))
          : null}
        {more ? (
          <Button disabled={busy} onClick={onMore}>
            Older changes
          </Button>
        ) : null}
      </section>
      {sources.kind === "error" || history.kind === "error" ? (
        <Button disabled={busy} onClick={onRetry}>
          Reload details
        </Button>
      ) : null}
    </>
  );
}
