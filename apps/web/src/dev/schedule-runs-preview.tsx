import { useState } from "react";
import type { ScheduleRuns } from "@winston/contracts/schedules";
import { ScheduleRunsView, type RunsState } from "../schedules/runs-view";
import { ManagementShell } from "../management/shell";
import { previewSchedules, SchedulesPreview } from "./schedules-preview";

export const previewRuns: ScheduleRuns["items"] = [
  {
    scheduleRevision: 2,
    dueAt: "2030-01-01T14:00:00.000Z",
    taskId: "33333333-3333-4333-8333-333333333333",
    state: "waiting",
    waiting: { kind: "device", detail: "Waiting for Studio Mac to reconnect." },
    result: null,
    truncated: false,
  },
  {
    scheduleRevision: 1,
    dueAt: "2029-12-25T14:00:00.000Z",
    taskId: "44444444-4444-4444-8444-444444444444",
    state: "failed",
    waiting: null,
    result: "The selected account needs to be reconnected.",
    truncated: false,
  },
  {
    scheduleRevision: 0,
    dueAt: "2029-12-18T14:00:00.000Z",
    taskId: "55555555-5555-4555-8555-555555555555",
    state: "succeeded",
    waiting: null,
    result: "Reminder delivered.",
    truncated: false,
  },
];

export function ScheduleRunsPreview({
  initial,
}: {
  initial: "ready" | "empty" | "loading" | "error";
}) {
  const [state, setState] = useState<RunsState>(
    initial === "ready" || initial === "empty"
      ? { kind: "ready", items: initial === "empty" ? [] : previewRuns }
      : { kind: initial },
  );
  const [back, setBack] = useState(false);
  const schedule = previewSchedules[0];
  if (!schedule) throw new Error("Missing schedule fixture.");
  if (back) return <SchedulesPreview initial={{ kind: "ready", items: [schedule] }} />;
  return (
    <ManagementShell
      preview
      activeHref="/schedules"
      onNavigate={() => {
        setBack(true);
      }}
    >
      <ScheduleRunsView
        schedule={schedule}
        state={state}
        onBack={() => {
          setBack(true);
        }}
        onMore={() => {}}
        onRefresh={() => {
          setState({ kind: "ready", items: previewRuns });
        }}
      />
    </ManagementShell>
  );
}
