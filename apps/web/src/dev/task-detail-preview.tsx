import { useState } from "react";
import type { TaskDetail } from "@winston/contracts/tasks";
import { TaskDetailView, type TaskDetailState } from "../activity/detail-view";
import { ManagementShell } from "../management/shell";
import { ActionEvidenceView } from "../activity/action-evidence-view";
import { CancelRequest } from "../activity/cancel-request";

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
  initial:
    | "ready"
    | "completed"
    | "loading"
    | "error"
    | "history-error"
    | "unknown"
    | "cancel-failed"
    | "actions-error";
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
  const [cancelFailed, setCancelFailed] = useState(initial === "cancel-failed");
  const [actionsError, setActionsError] = useState(initial === "actions-error");
  return (
    <ManagementShell preview activeHref="/activity" onNavigate={() => {}}>
      <TaskDetailView
        state={state}
        cancellation={
          state.kind === "ready" ? (
            <CancelRequest
              task={state.value}
              busy={false}
              failed={cancelFailed}
              onCancel={() => {
                setState({
                  kind: "ready",
                  value: { ...state.value, state: "canceled", waiting: null },
                });
              }}
            />
          ) : null
        }
        actions={
          <ActionEvidenceView
            checkedAt={Date.UTC(2030, 0, 1)}
            state={
              actionsError
                ? { kind: "error" }
                : {
                    kind: "ready",
                    value: {
                      unresolved: initial === "unknown" ? 1 : 0,
                      next: null,
                      items: [
                        {
                          id: "22222222-2222-4222-8222-222222222222",
                          intentRevision: 0,
                          authorization: {
                            operation: "device.command",
                            target: { kind: "device", id: value.id, resource: null },
                          },
                          state: initial === "unknown" ? "unknown" : "pending",
                          decisionSource: initial === "unknown" ? "owner" : null,
                          expiresAt: "2099-01-01T00:00:00.000Z",
                        },
                      ],
                    },
                  }
            }
            names={{ [`device:${value.id}`]: "Studio Mac" }}
            stopped={
              state.kind === "ready" &&
              ["canceled", "succeeded", "failed"].includes(state.value.state)
            }
            onMore={() => {}}
          />
        }
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
          setCancelFailed(false);
          setActionsError(false);
        }}
        onMore={() => {}}
      />
    </ManagementShell>
  );
}
