import { Button } from "@winston/ui";
import type { Handoff } from "@winston/contracts/handoffs";
import { ServiceIcon } from "../components/service-icon";

export type HandoffState =
  { kind: "loading" | "error" | "unavailable" } | { kind: "ready"; handoff: Handoff };

export function HandoffView({
  state,
  busy,
  failed,
  onAction,
  onRetry,
  onLeave,
}: {
  state: HandoffState;
  busy: boolean;
  failed: boolean;
  onAction: (action: "connect" | "renew" | "abandon") => void;
  onRetry: () => void;
  onLeave?: () => void;
}) {
  const handoff = state.kind === "ready" ? state.handoff : null;
  return (
    <section className="space-y-4 border-t border-line pt-5" aria-label="Task setup">
      <h2 className="text-base font-medium">Task setup</h2>
      {state.kind === "loading" ? (
        <p role="status" className="text-sm text-muted">
          Loading…
        </p>
      ) : null}
      {state.kind === "error" ? (
        <>
          <p role="alert" className="text-sm text-muted">
            Unable to load this request.
          </p>
          <Button onClick={onRetry}>Try again</Button>
        </>
      ) : null}
      {state.kind === "unavailable" ? (
        <p className="text-sm text-muted">This request is unavailable.</p>
      ) : null}
      {handoff ? (
        <>
          <p className="text-sm">{handoff.detail}</p>
          {handoff.state === "pending" ? (
            <div className="flex flex-wrap gap-2">
              {handoff.target.kind === "connection" ? (
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() => {
                    onAction("connect");
                  }}
                >
                  <ServiceIcon service={handoff.target.service} />
                  Connect {handoff.target.service === "gmail" ? "Gmail" : "Google Calendar"}
                </Button>
              ) : null}
              <Button
                disabled={busy}
                variant="quiet"
                onClick={() => {
                  onAction("abandon");
                }}
              >
                Cancel task
              </Button>
            </div>
          ) : handoff.state === "expired" ? (
            <>
              <p className="text-sm text-muted">This setup link expired.</p>
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={busy}
                  onClick={() => {
                    onAction("renew");
                  }}
                >
                  Renew link
                </Button>
                <Button
                  disabled={busy}
                  variant="quiet"
                  onClick={() => {
                    onAction("abandon");
                  }}
                >
                  Cancel task
                </Button>
              </div>
            </>
          ) : (
            <p role="status" className="text-sm text-muted">
              {handoff.state === "completed"
                ? "Connected. Winston can continue the task."
                : handoff.state === "abandoned"
                  ? "Task canceled."
                  : "This request is no longer needed."}
            </p>
          )}
        </>
      ) : null}
      {failed ? (
        <p role="alert" className="text-sm text-muted">
          Unable to finish setup. Please try again.
        </p>
      ) : null}
      <a className="text-sm text-muted underline underline-offset-4" href="/" onClick={onLeave}>
        Back to settings
      </a>
    </section>
  );
}
