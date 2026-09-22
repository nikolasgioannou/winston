import { useState } from "react";
import type { Connection } from "@winston/contracts/connections";
import { ConnectionsView, type ConnectionsState } from "../connections/connections-view";
import { SignInView } from "../auth/sign-in-view";
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
}: {
  initial: ConnectionsState;
  result?: string;
  calendarState?: "ready" | "empty" | "saving" | "error";
}) {
  const [state, setState] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [showCalendars, setShowCalendars] = useState(Boolean(calendarState));
  const [selected, setSelected] = useState(["primary"]);
  return (
    <SignInView state="signed-in" onSignIn={() => {}} onSignOut={() => {}} onRetry={() => {}}>
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
    </SignInView>
  );
}
