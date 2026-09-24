import { useState } from "react";
import { ActivityView, type ActivityItems, type ActivityState } from "../activity/activity-view";
import { ManagementShell } from "../management/shell";

const items: ActivityItems = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    revision: 2,
    createdAt: "2030-01-01T14:00:00.000000Z",
    updatedAt: "2030-01-01T14:01:00.000000Z",
    objective: "Find the trip notes on my Mac.",
    objectiveTruncated: false,
    state: "waiting",
    waiting: { kind: "device", detail: "Waiting for Studio Mac to reconnect." },
    result: null,
    resultTruncated: false,
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    revision: 3,
    createdAt: "2030-01-01T13:00:00.000000Z",
    updatedAt: "2030-01-01T13:01:00.000000Z",
    objective: "Check tomorrow’s calendar.",
    objectiveTruncated: false,
    state: "succeeded",
    waiting: null,
    result: "You have no events tomorrow morning.",
    resultTruncated: false,
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    revision: 1,
    createdAt: "2030-01-01T12:00:00.000000Z",
    updatedAt: "2030-01-01T12:01:00.000000Z",
    objective: "Find the receipt in Gmail.",
    objectiveTruncated: false,
    state: "failed",
    waiting: null,
    result: "The selected account needs to be reconnected.",
    resultTruncated: false,
  },
];

export function ActivityPreview({ initial }: { initial: "ready" | "empty" | "loading" | "error" }) {
  const [state, setState] = useState<ActivityState>(
    initial === "loading" || initial === "error"
      ? { kind: initial }
      : { kind: "ready", items: initial === "empty" ? [] : items },
  );

  return (
    <ManagementShell preview activeHref="/activity" onNavigate={() => {}}>
      <ActivityView
        state={state}
        onRefresh={() => {
          setState({ kind: "ready", items });
        }}
        onMore={() => {}}
      />
    </ManagementShell>
  );
}
