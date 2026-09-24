import { Button } from "@winston/ui";
import type {
  responsibilityHistorySchema,
  responsibilitySourcesSchema,
} from "@winston/contracts/responsibilities";
import { ResponsibilityScope, type ScopeNames } from "./scope";
import { SourceInstructions } from "../management/source-instructions";

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
      <SourceInstructions
        state={sources}
        changedMessage="This message changed after the proposal. Its original wording is unavailable."
      />
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
