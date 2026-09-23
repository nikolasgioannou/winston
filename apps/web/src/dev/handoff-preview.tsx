import { useState } from "react";
import { HandoffView, type HandoffState } from "../handoffs/handoff-view";
import type { Handoff } from "@winston/contracts/handoffs";
import { ManagementShell } from "../management/shell";

export const previewHandoff: Handoff = {
  id: "11111111-1111-4111-8111-111111111111",
  taskId: "22222222-2222-4222-8222-222222222222",
  taskRevision: 2,
  intentRevision: 0,
  target: { kind: "connection", service: "gmail", connectionId: null },
  detail: "Connect Gmail to find the itinerary you asked for.",
  state: "pending",
  expiresAt: "2030-01-01T00:00:00.000Z",
  resolutionId: null,
};

export function HandoffPreview({
  initial,
  busy = false,
  failed = false,
}: {
  initial: HandoffState;
  busy?: boolean;
  failed?: boolean;
}) {
  const [state, setState] = useState(initial);
  return (
    <ManagementShell preview activeHref="/handoffs/preview" onNavigate={() => {}}>
      <HandoffView
        state={state}
        busy={busy}
        failed={failed}
        onRetry={() => {
          setState({ kind: "ready", handoff: previewHandoff });
        }}
        onAction={(action) => {
          setState({
            kind: "ready",
            handoff: {
              ...previewHandoff,
              state:
                action === "connect" ? "completed" : action === "renew" ? "pending" : "abandoned",
            },
          });
        }}
      />
    </ManagementShell>
  );
}
