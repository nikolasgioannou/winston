import type { TaskActionEvidence } from "@winston/contracts/tasks";
import { Badge, Button } from "@winston/ui";
import { operationLabels } from "../management/operation-labels";

export type ActionEvidenceState =
  { kind: "loading" | "error" } | { kind: "ready"; value: TaskActionEvidence };
const labels = {
  pending: "Awaiting decision",
  approved: "Approved",
  denied: "Denied",
  dispatching: "In flight",
  unknown: "Outcome unknown",
  succeeded: "Completed",
  failed: "Failed",
  invalidated: "Not dispatched",
};

export function ActionEvidenceView({
  state,
  names = {},
  stopped,
  checkedAt,
  more = false,
  busy = false,
  onMore,
}: {
  state: ActionEvidenceState;
  names?: Record<string, string>;
  stopped: boolean;
  checkedAt: number;
  more?: boolean;
  busy?: boolean;
  onMore: () => void;
}) {
  return (
    <section aria-label="Actions" className="space-y-4 border-t border-line pt-6">
      <h2 className="text-sm font-medium">Actions</h2>
      {state.kind === "loading" ? (
        <p role="status" className="text-sm text-muted">
          Loading actions…
        </p>
      ) : null}
      {state.kind === "error" ? (
        <p role="alert" className="text-sm text-muted">
          Unable to load actions. Refresh to try again.
        </p>
      ) : null}
      {state.kind === "ready" ? (
        <>
          {state.value.unresolved > 0 ? (
            <p role="status" className="text-sm">
              {state.value.unresolved}{" "}
              {state.value.unresolved === 1 ? "action has" : "actions have"} no confirmed outcome.
              Stopping this request does not undo actions already sent.
            </p>
          ) : null}
          {state.value.items.length === 0 ? (
            <p className="text-sm text-muted">No recorded actions.</p>
          ) : null}
          <div className="divide-y divide-line">
            {state.value.items.map((item) => {
              const target = item.authorization.target;
              const name = names[`${target.kind}:${target.id}`];
              const pending = item.state === "pending" || item.state === "approved";
              const label =
                pending && stopped
                  ? "Not dispatched"
                  : pending && Date.parse(item.expiresAt) <= checkedAt
                    ? "Expired"
                    : labels[item.state];
              return (
                <article key={item.id} className="space-y-2 py-3 first:pt-0">
                  <div className="flex flex-wrap items-center gap-3">
                    <h3 className="text-sm font-medium">
                      {operationLabels[item.authorization.operation]}
                    </h3>
                    <Badge
                      tone={
                        item.state === "unknown" || item.state === "failed" ? "error" : "neutral"
                      }
                    >
                      {label}
                    </Badge>
                  </div>
                  <p className="text-sm wrap-anywhere">
                    {name ??
                      `${target.kind === "connection" ? "Account" : "Computer"} · ${target.id}`}
                    {target.resource ? ` · ${target.resource}` : ""}
                  </p>
                  {item.decisionSource ? (
                    <p className="text-xs text-muted">
                      {item.decisionSource === "owner" ? "Owner decision" : "Permission rule"}
                    </p>
                  ) : null}
                </article>
              );
            })}
          </div>
          {more ? (
            <Button disabled={busy} onClick={onMore}>
              More actions
            </Button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
