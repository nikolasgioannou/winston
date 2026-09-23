import { useState } from "react";
import type { Schedule } from "@winston/contracts/schedules";
import {
  SchedulesView,
  type SchedulesState,
  type ScheduleAction,
} from "../schedules/schedules-view";
import { ManagementShell } from "../management/shell";

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
  return embedded ? (
    content
  ) : (
    <ManagementShell preview activeHref="/schedules" onNavigate={() => {}}>
      {content}
    </ManagementShell>
  );
}
