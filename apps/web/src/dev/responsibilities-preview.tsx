import { useState } from "react";
import type { Responsibility } from "@winston/contracts/responsibilities";
import { ResponsibilitiesView } from "../responsibilities/responsibilities-view";
import { ManagementShell } from "../management/shell";

export const previewResponsibility: Responsibility = {
  id: "11111111-1111-4111-8111-111111111111",
  ownerId: "22222222-2222-4222-8222-222222222222",
  purpose: "Check for changes to my travel plans.",
  revision: 0,
  state: "proposed",
  scope: [
    {
      operation: "gmail.read",
      target: { kind: "connection", id: "33333333-3333-4333-8333-333333333333", resource: null },
    },
  ],
  sources: [],
  agreement: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
export type ResponsibilityPreviewState =
  Responsibility["state"] | "loading" | "error" | "empty" | "saving" | "uncertain";
export function ResponsibilitiesPreview({
  initial,
  embedded = false,
}: {
  initial: ResponsibilityPreviewState;
  embedded?: boolean;
}) {
  const [items, setItems] = useState<Responsibility[]>(
    initial === "empty"
      ? []
      : [
          {
            ...previewResponsibility,
            state:
              initial === "active" || initial === "paused" || initial === "ended"
                ? initial
                : "proposed",
            agreement:
              initial === "active" || initial === "paused"
                ? { proposalRevision: 0, at: previewResponsibility.createdAt }
                : null,
          },
        ],
  );
  const [status, setStatus] = useState(initial);
  const content = (
    <ResponsibilitiesView
      state={
        status === "loading" || status === "error" ? { kind: status } : { kind: "ready", items }
      }
      names={{ "connection:33333333-3333-4333-8333-333333333333": "alex@example.com" }}
      busy={status === "saving"}
      pending={status === "saving"}
      failure={status === "uncertain"}
      onRefresh={() => {
        setStatus("proposed");
        setItems([previewResponsibility]);
      }}
      onMore={() => {}}
      onChange={(item, action) => {
        setItems((previous) =>
          previous.map((entry) =>
            entry.id === item.id
              ? {
                  ...entry,
                  revision: entry.revision + 1,
                  state: action === "end" ? "ended" : action === "pause" ? "paused" : "active",
                  agreement:
                    action === "agree"
                      ? { proposalRevision: entry.revision, at: entry.createdAt }
                      : entry.agreement,
                }
              : entry,
          ),
        );
      }}
    />
  );
  return embedded ? (
    content
  ) : (
    <ManagementShell preview activeHref="/responsibilities" onNavigate={() => {}}>
      {content}
    </ManagementShell>
  );
}
