import { useState } from "react";
import type { TaskDetail } from "@winston/contracts/tasks";
import { TaskDetailView, type TaskDetailState } from "../activity/detail-view";
import { ManagementShell } from "../management/shell";

const value: TaskDetail = {
  id: "11111111-1111-4111-8111-111111111111",
  revision: 2,
  createdAt: "2030-01-01T14:00:00.000000Z",
  updatedAt: "2030-01-01T14:01:00.000000Z",
  objective: "Find the trip notes on my Mac.",
  state: "waiting",
  waiting: { kind: "device", detail: "Waiting for Studio Mac to reconnect." },
  result: null,
};

export function TaskDetailPreview({
  initial,
}: {
  initial: "ready" | "completed" | "loading" | "error" | "history-error";
}) {
  const [state, setState] = useState<TaskDetailState>(
    initial === "loading" || initial === "error"
      ? { kind: initial }
      : {
          kind: "ready",
          value:
            initial === "completed"
              ? {
                  ...value,
                  state: "succeeded",
                  waiting: null,
                  result: "The trip notes are in Documents/Travel.",
                }
              : value,
        },
  );
  const [historyError, setHistoryError] = useState(initial === "history-error");
  return (
    <ManagementShell preview activeHref="/activity" onNavigate={() => {}}>
      <TaskDetailView
        state={state}
        history={
          historyError
            ? { kind: "error" }
            : {
                kind: "ready",
                items: [{ ...value, objectiveTruncated: false, resultTruncated: false }],
              }
        }
        onRefresh={() => {
          setState({ kind: "ready", value });
          setHistoryError(false);
        }}
        onMore={() => {}}
      />
    </ManagementShell>
  );
}
