import { Button } from "@winston/ui";
import { ServiceIcon } from "../components/service-icon";

export type PairingState =
  | { kind: "loading" | "disconnected" | "error" }
  | { kind: "waiting"; id: string; url?: string }
  | { kind: "candidate"; id: string; userId: string; name: string }
  | { kind: "connected"; userId: string };

export function PairingView({
  state,
  onConnect,
  onConfirm,
  onDisconnect,
  onRetry,
}: {
  state: PairingState;
  onConnect: () => void;
  onConfirm: () => void;
  onDisconnect: () => void;
  onRetry: () => void;
}) {
  return (
    <section aria-label="Telegram" className="space-y-3 border-t border-line pt-5">
      <h2 className="text-sm font-medium">Telegram</h2>
      {state.kind === "loading" ? <p className="text-sm text-muted">Checking connection…</p> : null}
      {state.kind === "disconnected" ? (
        <Button onClick={onConnect}>
          <ServiceIcon service="telegram" />
          Connect Telegram
        </Button>
      ) : null}
      {state.kind === "error" ? (
        <>
          <p className="text-sm text-muted">Unable to check Telegram. Try again.</p>
          <Button onClick={onRetry}>Retry connection</Button>
        </>
      ) : null}
      {state.kind === "waiting" ? (
        <>
          <p className="text-sm text-muted">
            Open Telegram and press Start. Return here to confirm your account.
          </p>
          {state.url ? (
            <Button
              nativeButton={false}
              role="link"
              render={
                <a href={state.url} target="_blank" rel="noreferrer" aria-label="Open Telegram" />
              }
            >
              <ServiceIcon service="telegram" />
              Open Telegram
            </Button>
          ) : null}
          <Button variant="quiet" onClick={onConnect}>
            Start again
          </Button>
        </>
      ) : null}
      {state.kind === "candidate" ? (
        <>
          <p className="text-sm">
            Connect {state.name} (ID {state.userId})?
          </p>
          <Button variant="primary" onClick={onConfirm}>
            <ServiceIcon service="telegram" />
            Confirm Telegram account
          </Button>
          <Button variant="quiet" onClick={onConnect}>
            Use another account
          </Button>
        </>
      ) : null}
      {state.kind === "connected" ? (
        <>
          <p className="text-sm text-muted">Connected · {state.userId}</p>
          <Button onClick={onDisconnect}>
            <ServiceIcon service="telegram" />
            Disconnect Telegram
          </Button>
        </>
      ) : null}
    </section>
  );
}
