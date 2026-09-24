import type { MessageSource } from "@winston/contracts/messages";

export type SourceInstructionsState =
  { kind: "loading" | "error" } | { kind: "ready"; value: { items: MessageSource[] } };

export function SourceInstructions({
  state,
  changedMessage = "This message changed after it was recorded. Its original wording is unavailable.",
}: {
  state: SourceInstructionsState;
  changedMessage?: string;
}) {
  return (
    <section aria-label="Source instructions" className="space-y-3 border-t border-line pt-5">
      <h2 className="text-sm font-medium">Source instructions</h2>
      {state.kind === "loading" ? (
        <p role="status" className="text-sm text-muted">
          Loading instructions…
        </p>
      ) : null}
      {state.kind === "error" ? (
        <p role="alert" className="text-sm text-muted">
          Unable to load source instructions.
        </p>
      ) : null}
      {state.kind === "ready" && !state.value.items.length ? (
        <p className="text-sm text-muted">No linked message.</p>
      ) : null}
      {state.kind === "ready"
        ? state.value.items.map((source) => (
            <div key={source.messageId} className="space-y-2 text-sm">
              {source.status !== "current" ? (
                <p className="text-muted">
                  {source.status === "changed"
                    ? changedMessage
                    : source.status === "uncaptured"
                      ? "The original version of this message was not recorded."
                      : "This source message is unavailable."}
                </p>
              ) : (
                <>
                  <p className="text-xs text-muted">
                    Telegram ·{" "}
                    {new Intl.DateTimeFormat(undefined, {
                      dateStyle: "medium",
                      timeStyle: "short",
                      timeZone: source.sentAt.timezone,
                    }).format(new Date(source.sentAt.instant))}{" "}
                    · {source.sentAt.timezone}
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
  );
}
