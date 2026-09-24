import { useState } from "react";
import { ScheduleEditorView } from "../schedules/editor-view";
import { EditorStatus } from "../schedules/editor-status";
import { ManagementShell } from "../management/shell";
import { previewSchedules, SchedulesPreview } from "./schedules-preview";

export type EditorPreviewState =
  "ready" | "paused" | "canceled" | "saving" | "conflict" | "loading" | "error";
export function ScheduleEditorPreview({ initial }: { initial: EditorPreviewState }) {
  const [state, setState] = useState(initial);
  const [back, setBack] = useState(false);
  const fixture = previewSchedules[0];
  if (!fixture) throw new Error("Missing schedule fixture.");
  const [schedule, setSchedule] = useState({
    ...fixture,
    state:
      initial === "paused"
        ? ("paused" as const)
        : initial === "canceled"
          ? ("canceled" as const)
          : ("active" as const),
  });
  if (back) return <SchedulesPreview initial={{ kind: "ready", items: [schedule] }} />;
  return (
    <ManagementShell
      preview
      activeHref="/schedules"
      onNavigate={() => {
        setBack(true);
      }}
    >
      {state === "loading" || state === "error" ? (
        <EditorStatus
          state={state}
          onRetry={() => {
            setState("ready");
          }}
          onBack={() => {
            setBack(true);
          }}
        />
      ) : (
        <ScheduleEditorView
          schedule={schedule}
          busy={state === "saving"}
          failed={state === "conflict"}
          onReload={() => {
            setState("ready");
          }}
          onBack={() => {
            setBack(true);
          }}
          onSave={(input) => {
            setSchedule({ ...schedule, ...input, revision: schedule.revision + 1 });
            setBack(true);
          }}
        />
      )}
    </ManagementShell>
  );
}
