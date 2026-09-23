import { useState } from "react";
import type { Connection } from "@winston/contracts/connections";
import { ConnectionsView, type ConnectionsState } from "../connections/connections-view";
import { ManagementShell } from "../management/shell";
import { CalendarSelectionView } from "../connections/calendar-selection-view";

export const previewConnections: Connection[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    subject: "account-a",
    email: "alex@example.com",
    service: "gmail",
    status: "connected",
    revision: 0,
    scopes: [],
    calendars: [],
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    subject: "account-b",
    email: "work@example.com",
    service: "calendar",
    status: "connected",
    revision: 0,
    scopes: [],
    calendars: ["primary"],
  },
];

export function ConnectionsPreview({
  initial,
  result,
  calendarState,
  embedded = false,
}: {
  initial: ConnectionsState;
  result?: string;
  calendarState?: "ready" | "empty" | "saving" | "error";
  embedded?: boolean;
}) {
  const [state, setState] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [showCalendars, setShowCalendars] = useState(Boolean(calendarState));
  const [selected, setSelected] = useState(["primary"]);
  const content = (
    <>
      <ConnectionsView
        state={state}
        busy={busy}
        {...(result ? { result } : {})}
        onConnect={() => {
          setBusy(true);
        }}
        onReconnect={() => {
          setBusy(true);
        }}
        onDisconnect={(connection) => {
          if (state.kind === "ready")
            setState({
              kind: "ready",
              connections: state.connections.map((item) =>
                item.id === connection.id
                  ? { ...item, status: "disconnected", revision: item.revision + 1 }
                  : item,
              ),
            });
        }}
        onCalendars={() => {
          setShowCalendars(true);
        }}
        onRetry={() => {
          setState({ kind: "ready", connections: [] });
        }}
      />
      {showCalendars ? (
        <CalendarSelectionView
          items={
            calendarState === "empty"
              ? []
              : [
                  { id: "primary", summary: "Personal", accessRole: "owner" },
                  { id: "team", summary: "Team", accessRole: "reader" },
                ]
          }
          selected={selected}
          busy={calendarState === "saving"}
          error={calendarState === "error"}
          onToggle={(id) => {
            setSelected((current) =>
              current.includes(id)
                ? current.filter((selectedId) => selectedId !== id)
                : [...current, id],
            );
          }}
          onSave={() => {
            setShowCalendars(false);
          }}
          onCancel={() => {
            setShowCalendars(false);
          }}
        />
      ) : null}
    </>
  );
  return embedded ? (
    content
  ) : (
    <ManagementShell preview activeHref="/connections" onNavigate={() => {}}>
      <h1 className="text-xl font-medium">Connections</h1>
      {content}
    </ManagementShell>
  );
}
