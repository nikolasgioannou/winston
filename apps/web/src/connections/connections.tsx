import { useCallback, useEffect, useRef, useState } from "react";
import {
  calendarListSchema,
  connectionListSchema,
  connectionUrlSchema,
  type Connection,
  type ConnectionStart,
  type GoogleCalendar,
} from "@winston/contracts/connections";
import { ConnectionsView, type ConnectionsState } from "./connections-view";
import { CalendarSelectionView } from "./calendar-selection-view";

export function Connections() {
  const [state, setState] = useState<ConnectionsState>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [calendarError, setCalendarError] = useState(false);
  const [result, setResult] = useState<string | undefined>(
    () => new URLSearchParams(window.location.search).get("connection_result") ?? undefined,
  );
  const [calendars, setCalendars] = useState<{
    connection: Connection;
    items: GoogleCalendar[];
    selected: string[];
  } | null>(null);
  const revision = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++revision.current;
    try {
      const response = await fetch("/api/owner/connections", { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error();
      const connections = connectionListSchema.parse(await response.json());
      if (current === revision.current) setState({ kind: "ready", connections });
      return connections;
    } catch {
      if (current === revision.current) setState({ kind: "error" });
    }
  }, []);
  useEffect(() => {
    let active = true;
    const url = new URL(window.location.href);
    url.searchParams.delete("connection_result");
    window.history.replaceState(null, "", url.pathname + url.search);
    Promise.resolve()
      .then(() => {
        if (active) return refresh();
      })
      .catch(() => {});
    return () => {
      active = false;
      revision.current += 1;
    };
  }, [refresh]);

  async function connect(intent: ConnectionStart) {
    setBusy(true);
    setResult(undefined);
    try {
      const response = await fetch("/api/owner/connections/google", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(intent),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error();
      const { url } = connectionUrlSchema.parse(await response.json());
      if (new URL(url).origin !== "https://accounts.google.com") throw new Error();
      window.location.assign(url);
    } catch {
      setResult("failed");
      setBusy(false);
    }
  }
  async function showCalendars(connection: Connection) {
    setBusy(true);
    setResult(undefined);
    setCalendarError(false);
    try {
      const response = await fetch(`/api/owner/connections/${connection.id}/calendars`, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error();
      setCalendars({
        connection,
        items: calendarListSchema.parse(await response.json()),
        selected: connection.calendars,
      });
    } catch {
      setResult("calendars-failed");
      await refresh();
    } finally {
      setBusy(false);
    }
  }
  async function disconnect(connection: Connection) {
    setBusy(true);
    setResult(undefined);
    try {
      const response = await fetch(`/api/owner/connections/${connection.id}/disconnect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision: connection.revision }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error();
      if (calendars?.connection.id === connection.id) setCalendars(null);
      await refresh();
    } catch {
      setResult("disconnect-failed");
    } finally {
      setBusy(false);
    }
  }
  async function saveCalendars() {
    if (!calendars) return;
    setBusy(true);
    setCalendarError(false);
    try {
      const response = await fetch(`/api/owner/connections/${calendars.connection.id}/calendars`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision: calendars.connection.revision, ids: calendars.selected }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error();
      setCalendars(null);
      await refresh();
    } catch {
      setCalendarError(true);
      const latest = await refresh();
      setCalendars((current) => {
        const connection = latest?.find((item) => item.id === current?.connection.id);
        return current && connection ? { ...current, connection } : current;
      });
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <ConnectionsView
        state={state}
        busy={busy}
        {...(result ? { result } : {})}
        onConnect={(service) => {
          connect({ service }).catch(() => {});
        }}
        onReconnect={(connection) => {
          connect({ service: connection.service, connectionId: connection.id }).catch(() => {});
        }}
        onDisconnect={(connection) => {
          disconnect(connection).catch(() => {});
        }}
        onCalendars={(connection) => {
          showCalendars(connection).catch(() => {});
        }}
        onRetry={() => {
          refresh().catch(() => {});
        }}
      />
      {calendars ? (
        <CalendarSelectionView
          items={calendars.items}
          selected={calendars.selected}
          busy={busy}
          error={calendarError}
          onToggle={(id) => {
            setCalendars({
              ...calendars,
              selected: calendars.selected.includes(id)
                ? calendars.selected.filter((selectedId) => selectedId !== id)
                : [...calendars.selected, id],
            });
          }}
          onSave={() => {
            saveCalendars().catch(() => {});
          }}
          onCancel={() => {
            setCalendars(null);
          }}
        />
      ) : null}
    </>
  );
}
