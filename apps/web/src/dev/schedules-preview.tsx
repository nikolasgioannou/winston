import { useState } from "react";
import type { Schedule } from "@winston/contracts/schedules";
import {
  SchedulesView,
  type SchedulesState,
  type ScheduleAction,
} from "../schedules/schedules-view";
import { ManagementShell } from "../management/shell";
import { ScheduleEditorView } from "../schedules/editor-view";
import { ScheduleRunsView } from "../schedules/runs-view";

export const previewSchedules: Schedule[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    ownerId: "22222222-2222-4222-8222-222222222222",
    revision: 0,
    state: "active",
    objective: "Remind me to water the plants.",
    sourceMessageIds: [],
    timing: {
      kind: "recurring",
      startAt: "2030-01-01T14:00:00.000Z",
      timezone: "America/New_York",
      rule: "FREQ=WEEKLY;BYDAY=TU",
    },
    nextRunAt: "2030-01-01T14:00:00.000Z",
  },
];

export function SchedulesPreview({
  initial,
  busy = false,
  action = "cancel",
  failed = false,
  embedded = false,
}: {
  initial: SchedulesState;
  busy?: boolean;
  action?: ScheduleAction;
  failed?: boolean;
  embedded?: boolean;
}) {
  const [state, setState] = useState(initial);
  const [failure, setFailure] = useState(failed);
  const [editing, setEditing] = useState<Schedule | null>(null);
  const [history, setHistory] = useState<Schedule | null>(null);
  const content = (
    <SchedulesView
      state={state}
      busy={busy}
      pendingAction={busy ? action : null}
      failure={failure}
      onRefresh={() => {
        setState({ kind: "ready", items: previewSchedules });
        setFailure(false);
      }}
      onMore={() => {}}
      onEdit={setEditing}
      onHistory={setHistory}
      onPause={(schedule) => {
        if (state.kind === "ready")
          setState({
            kind: "ready",
            items: state.items.map((item) =>
              item.id === schedule.id
                ? { ...item, state: "paused", nextRunAt: null, revision: item.revision + 1 }
                : item,
            ),
          });
      }}
      onResume={(schedule) => {
        if (state.kind === "ready")
          setState({
            kind: "ready",
            items: state.items.map((item) =>
              item.id === schedule.id
                ? {
                    ...item,
                    state: "active",
                    nextRunAt: item.timing.startAt,
                    revision: item.revision + 1,
                  }
                : item,
            ),
          });
      }}
      onCancel={(schedule) => {
        if (state.kind === "ready")
          setState({
            kind: "ready",
            items: state.items.map((item) =>
              item.id === schedule.id
                ? {
                    ...item,
                    state: "canceled",
                    nextRunAt: null,
                    revision: item.revision + 1,
                  }
                : item,
            ),
          });
      }}
    />
  );
  const page = history ? (
    <ScheduleRunsView
      schedule={history}
      state={{ kind: "ready", items: [] }}
      onBack={() => {
        setHistory(null);
      }}
      onRefresh={() => {}}
      onMore={() => {}}
    />
  ) : editing ? (
    <ScheduleEditorView
      schedule={editing}
      onBack={() => {
        setEditing(null);
      }}
      onReload={() => {}}
      onSave={(input) => {
        if (state.kind === "ready")
          setState({
            kind: "ready",
            items: state.items.map((item) =>
              item.id === editing.id ? { ...item, ...input, revision: item.revision + 1 } : item,
            ),
          });
        setEditing(null);
      }}
    />
  ) : (
    content
  );
  return embedded ? (
    page
  ) : (
    <ManagementShell preview activeHref="/schedules" onNavigate={() => {}}>
      {page}
    </ManagementShell>
  );
}
