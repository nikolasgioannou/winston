import { useState } from "react";
import { Badge, Button } from "@winston/ui";
import type { Responsibility } from "@winston/contracts/responsibilities";
import { ResponsibilityScope, type ScopeNames } from "./scope";

export type ResponsibilitiesState =
  { kind: "loading" | "error" } | { kind: "ready"; items: Responsibility[] };
export type ResponsibilityAction = "agree" | "pause" | "resume" | "end";

export function ResponsibilitiesView({
  state,
  names = {},
  namesReady = true,
  busy = false,
  pending = false,
  failure = false,
  more = false,
  onRefresh,
  onMore,
  onChange,
}: {
  state: ResponsibilitiesState;
  names?: ScopeNames;
  namesReady?: boolean;
  busy?: boolean;
  pending?: boolean;
  failure?: boolean;
  more?: boolean;
  onRefresh: () => void;
  onMore: () => void;
  onChange: (item: Responsibility, action: ResponsibilityAction) => void;
}) {
  const [review, setReview] = useState<{
    item: Responsibility;
    action: "agree" | "end";
    names: ScopeNames;
  } | null>(null);
  return (
    <>
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-xl font-medium">Responsibilities</h1>
        <Button
          variant="quiet"
          disabled={busy}
          onClick={() => {
            setReview(null);
            onRefresh();
          }}
        >
          Refresh
        </Button>
      </div>
      {state.kind === "loading" ? (
        <p role="status" className="text-sm text-muted">
          Loading responsibilities…
        </p>
      ) : null}
      {state.kind === "error" ? (
        <p role="alert" className="text-sm text-muted">
          Unable to load responsibilities. Refresh to try again.
        </p>
      ) : null}
      {pending ? (
        <p role="status" className="text-sm text-muted">
          Saving change…
        </p>
      ) : null}
      {failure ? (
        <p role="alert" className="text-sm text-muted">
          Could not confirm the change. Refresh to check the current status.
        </p>
      ) : null}
      {!namesReady ? (
        <p role="status" className="text-sm text-muted">
          Account and computer names are unavailable. Refresh before agreeing.
        </p>
      ) : null}
      {state.kind === "ready" && !state.items.length ? (
        <p className="text-sm text-muted">No responsibilities yet.</p>
      ) : null}
      {state.kind === "ready" ? (
        <div className="divide-y divide-line">
          {state.items.map((current) => {
            const selected = review?.item.id === current.id ? review : null;
            const item = selected?.item ?? current;
            const blocked = busy || failure;
            return (
              <section
                key={current.id}
                aria-label={item.purpose}
                className="space-y-3 py-5 first:pt-0"
              >
                <h2 className="text-sm font-medium whitespace-pre-wrap wrap-anywhere">
                  {item.purpose}
                </h2>
                <Badge tone={item.state === "active" ? "success" : "neutral"}>
                  {item.state === "proposed"
                    ? "Proposed"
                    : item.state === "active"
                      ? "Agreed"
                      : item.state === "paused"
                        ? "Paused"
                        : "Ended"}
                </Badge>
                <ResponsibilityScope scope={item.scope} names={selected?.names ?? names} />
                {item.state === "paused" ? (
                  <p className="text-sm text-muted">
                    Resuming this agreement keeps existing schedules paused.
                  </p>
                ) : null}
                {selected ? (
                  <div className="space-y-2">
                    <p className="text-sm">
                      {selected.action === "agree"
                        ? "Agree to this responsibility? App permissions still apply."
                        : "End this responsibility and cancel its scheduled checks?"}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        disabled={blocked || (selected.action === "agree" && !namesReady)}
                        onClick={() => {
                          onChange(selected.item, selected.action);
                          setReview(null);
                        }}
                      >
                        {selected.action === "agree" ? "Confirm agreement" : "End responsibility"}
                      </Button>
                      <Button
                        variant="quiet"
                        disabled={busy}
                        onClick={() => {
                          setReview(null);
                        }}
                      >
                        Back
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2 empty:hidden">
                    {item.state === "proposed" ? (
                      <Button
                        disabled={blocked || !namesReady}
                        onClick={() => {
                          setReview({ item, action: "agree", names: { ...names } });
                        }}
                      >
                        Review agreement
                      </Button>
                    ) : null}
                    {item.state === "active" || item.state === "paused" ? (
                      <Button
                        variant="quiet"
                        disabled={blocked}
                        onClick={() => {
                          onChange(item, item.state === "paused" ? "resume" : "pause");
                        }}
                      >
                        {item.state === "paused" ? "Resume" : "Pause"}
                      </Button>
                    ) : null}
                    {item.state !== "ended" ? (
                      <Button
                        variant="quiet"
                        disabled={blocked}
                        onClick={() => {
                          setReview({ item, action: "end", names: { ...names } });
                        }}
                      >
                        End
                      </Button>
                    ) : null}
                  </div>
                )}
              </section>
            );
          })}
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
