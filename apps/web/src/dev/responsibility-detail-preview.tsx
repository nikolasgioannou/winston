import { useState } from "react";
import type { Responsibility } from "@winston/contracts/responsibilities";
import { ResponsibilityDetailView } from "../responsibilities/detail-view";
import type { Sources } from "../responsibilities/evidence";
import { ManagementShell } from "../management/shell";
import { previewResponsibility, ResponsibilitiesPreview } from "./responsibilities-preview";

export type DetailPreviewState =
  | "ready"
  | "editing"
  | "ended"
  | "loading"
  | "error"
  | "source-changed"
  | "evidence-error"
  | "saving"
  | "uncertain";
export function ResponsibilityDetailPreview({ initial }: { initial: DetailPreviewState }) {
  const [state, setState] = useState(initial);
  const [back, setBack] = useState(false);
  const [editing, setEditing] = useState(["editing", "saving", "uncertain"].includes(initial));
  const [item, setItem] = useState<Responsibility>({
    ...previewResponsibility,
    state: initial === "ended" ? "ended" : "proposed",
  });
  const [history, setHistory] = useState([item]);
  const sources: Sources = {
    id: item.id,
    revision: item.revision,
    items: [
      {
        messageId: "44444444-4444-4444-8444-444444444444",
        revision: 0,
        status: "current",
        kind: "text",
        text: "Keep an eye on changes to my travel plans. Let me know if anything needs attention.",
        transcript: null,
        truncated: false,
        sentAt: {
          instant: "2026-01-01T15:00:00.000Z",
          timezone: "America/New_York",
          offset: "-05:00",
        },
      },
    ],
  };
  if (back) return <ResponsibilitiesPreview initial="proposed" />;
  return (
    <ManagementShell preview activeHref="/responsibilities" onNavigate={() => {}}>
      <ResponsibilityDetailView
        state={
          state === "loading" || state === "error"
            ? { kind: state }
            : { kind: "ready", value: item }
        }
        sources={
          state === "evidence-error"
            ? { kind: "error" }
            : {
                kind: "ready",
                value:
                  state === "source-changed"
                    ? {
                        ...sources,
                        items: sources.items.map((source) => ({
                          messageId: source.messageId,
                          revision: source.revision,
                          status: "changed",
                        })),
                      }
                    : sources,
              }
        }
        history={
          state === "evidence-error"
            ? { kind: "error" }
            : { kind: "ready", value: { items: history, next: null } }
        }
        names={{ "connection:33333333-3333-4333-8333-333333333333": "alex@example.com" }}
        namesReady
        busy={state === "saving"}
        failed={state === "uncertain"}
        editing={editing}
        more={false}
        onBack={() => {
          setBack(true);
        }}
        onEdit={setEditing}
        onMore={() => {}}
        onRefresh={() => {
          setState("ready");
          setEditing(false);
        }}
        onSave={(input) => {
          const updated: Responsibility = {
            ...item,
            ...input,
            revision: item.revision + 1,
            state: "proposed",
            agreement: null,
          };
          setItem(updated);
          setHistory((current) => [updated, ...current]);
          setEditing(false);
        }}
        onChange={(current, action) => {
          const updated: Responsibility = {
            ...current,
            revision: current.revision + 1,
            state: action === "end" ? "ended" : action === "pause" ? "paused" : "active",
            agreement:
              action === "agree"
                ? { proposalRevision: current.revision, at: current.updatedAt }
                : current.agreement,
          };
          setItem(updated);
          setHistory((previous) => [updated, ...previous]);
        }}
      />
    </ManagementShell>
  );
}
