import { Button, Badge } from "@winston/ui";
import type { Connection, GoogleService } from "@winston/contracts/connections";
import { ServiceIcon } from "../components/service-icon";

export type ConnectionsState =
  { kind: "loading" } | { kind: "error" } | { kind: "ready"; connections: Connection[] };

export function ConnectionsView({
  state,
  busy,
  result,
  onConnect,
  onReconnect,
  onDisconnect,
  onCalendars,
  onRetry,
}: {
  state: ConnectionsState;
  busy: boolean;
  result?: string;
  onConnect: (service: GoogleService) => void;
  onReconnect: (connection: Connection) => void;
  onDisconnect: (connection: Connection) => void;
  onCalendars: (connection: Connection) => void;
  onRetry: () => void;
}) {
  return (
    <section className="space-y-3" aria-label="Connected apps">
      {result === "disconnect-failed" ? (
        <p role="alert" className="text-sm text-muted">
          Could not disconnect. Try again.
        </p>
      ) : null}
      {result === "calendars-failed" ? (
        <p role="alert" className="text-sm text-muted">
          Could not load calendars. Try again or reconnect this account.
        </p>
      ) : null}
      {result === "failed" ? (
        <p role="alert" className="text-sm text-muted">
          Connection failed. Try connecting again.
        </p>
      ) : null}
      {result === "limited" ? (
        <p role="status" className="text-sm text-muted">
          Some permissions were declined. Reconnect to grant access.
        </p>
      ) : null}
      {state.kind === "loading" ? (
        <p role="status" className="text-sm text-muted">
          Loading connections…
        </p>
      ) : state.kind === "error" ? (
        <Button onClick={onRetry}>Retry connections</Button>
      ) : (
        <>
          {state.connections.map((connection) => (
            <div key={connection.id} className="space-y-2 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-2 text-sm">
                  <ServiceIcon service={connection.service} />
                  {connection.service === "gmail" ? "Gmail" : "Google Calendar"}
                </span>
                <Badge>
                  {connection.status === "connected"
                    ? "Connected"
                    : connection.status === "limited"
                      ? "Limited access"
                      : connection.status === "disconnected"
                        ? "Disconnected"
                        : "Reconnect"}
                </Badge>
              </div>
              <p className="truncate text-sm text-muted" title={connection.email}>
                {connection.email}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    onReconnect(connection);
                  }}
                >
                  Reconnect
                </Button>
                {connection.status !== "disconnected" ? (
                  <Button
                    size="sm"
                    disabled={busy}
                    title="Remove this connection from Winston. Google account permissions remain unchanged."
                    onClick={() => {
                      onDisconnect(connection);
                    }}
                  >
                    Disconnect
                  </Button>
                ) : null}
                {connection.service === "calendar" && connection.status === "connected" ? (
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      onCalendars(connection);
                    }}
                  >
                    Calendars
                    {connection.calendars.length ? ` (${String(connection.calendars.length)})` : ""}
                  </Button>
                ) : null}
              </div>
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={busy}
              onClick={() => {
                onConnect("gmail");
              }}
            >
              <ServiceIcon service="gmail" />
              Connect Gmail
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                onConnect("calendar");
              }}
            >
              <ServiceIcon service="calendar" />
              Connect Calendar
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
