import { useState, type ComponentType } from "react";
import { ComponentGallery } from "./component-gallery";
import { FoundationShell } from "./foundation-shell";
import { SignInView, type SignInState } from "../auth/sign-in-view";
import { PairingView, type PairingState } from "../telegram/pairing-view";
import { ConnectionsPreview, previewConnections } from "./connections-preview";
import { HandoffPreview, previewHandoff } from "./handoff-preview";
import { DownloadPreview, previewDownload } from "./download-preview";
import { ManagementPreview } from "./management-preview";
import { ManagementShell } from "../management/shell";
import { AccountView } from "../management/account-view";
import { SchedulesPreview, previewSchedules } from "./schedules-preview";

function PairingPreview({ initial }: { initial: PairingState }) {
  const [state, setState] = useState(initial);

  return (
    <ManagementShell preview activeHref="/" onNavigate={() => {}}>
      <AccountView onSignOut={() => {}}>
        <PairingView
          state={state}
          onConnect={() => {
            setState({ kind: "waiting", id: "preview" });
          }}
          onConfirm={() => {
            setState({ kind: "connected", userId: "123456" });
          }}
          onDisconnect={() => {
            setState({ kind: "disconnected" });
          }}
          onRetry={() => {
            setState({ kind: "disconnected" });
          }}
        />
      </AccountView>
    </ManagementShell>
  );
}

function SignInPreview({ initial }: { initial: SignInState }) {
  const [state, setState] = useState(initial);

  if (state === "signed-in") return <ManagementPreview initial="/" />;

  return (
    <SignInView
      state={state}
      onSignIn={() => {
        setState("redirecting");
      }}
      onSignOut={() => {
        setState("signed-out");
      }}
      onRetry={() => {
        setState("signed-out");
      }}
    />
  );
}

export type ReviewState = {
  id: string;
  label: string;
  render: ComponentType;
  fullWidth?: boolean;
};

export type ReviewPage = {
  id: string;
  label: string;
  kind: "foundation" | "page";
  states: readonly [ReviewState, ...ReviewState[]];
};

// Page registrations import real view components and supply local fixture adapters.
// Production data hooks and actions must stay outside those view components.
export const reviewPages: readonly ReviewPage[] = [
  {
    id: "schedules",
    label: "Schedules",
    kind: "page",
    states: [
      {
        id: "active",
        label: "Active",
        fullWidth: true,
        render: () => <SchedulesPreview initial={{ kind: "ready", items: previewSchedules }} />,
      },
      {
        id: "empty",
        label: "Empty",
        fullWidth: true,
        render: () => <SchedulesPreview initial={{ kind: "ready", items: [] }} />,
      },
      {
        id: "loading",
        label: "Loading",
        fullWidth: true,
        render: () => <SchedulesPreview initial={{ kind: "loading" }} />,
      },
      {
        id: "error",
        label: "Unavailable",
        fullWidth: true,
        render: () => <SchedulesPreview initial={{ kind: "error" }} />,
      },
      {
        id: "canceling",
        label: "Canceling",
        fullWidth: true,
        render: () => (
          <SchedulesPreview busy initial={{ kind: "ready", items: previewSchedules }} />
        ),
      },
      {
        id: "uncertain",
        label: "Cancellation unconfirmed",
        fullWidth: true,
        render: () => (
          <SchedulesPreview failed initial={{ kind: "ready", items: previewSchedules }} />
        ),
      },
      ...(["canceled", "completed"] as const).map((state) => ({
        id: state,
        label: state === "completed" ? "No upcoming runs" : "Canceled",
        fullWidth: true,
        render: () => (
          <SchedulesPreview
            initial={{
              kind: "ready",
              items: previewSchedules.map((schedule) => ({ ...schedule, state, nextRunAt: null })),
            }}
          />
        ),
      })),
    ],
  },
  {
    id: "management",
    label: "Management",
    kind: "page",
    states: [
      {
        id: "account",
        label: "Account",
        fullWidth: true,
        render: () => <ManagementPreview initial="/" />,
      },
      {
        id: "connections",
        label: "Connections",
        fullWidth: true,
        render: () => <ManagementPreview initial="/connections" />,
      },
    ],
  },
  {
    id: "download",
    label: "File download",
    kind: "page",
    states: [
      {
        id: "ready",
        label: "Ready",
        fullWidth: true,
        render: () => <DownloadPreview initial={previewDownload} />,
      },
      ...(["loading", "error", "expired", "unavailable"] as const).map((kind) => ({
        id: kind,
        label: kind,
        fullWidth: true,
        render: () => <DownloadPreview initial={{ kind }} />,
      })),
      {
        id: "downloading",
        label: "Preparing download",
        fullWidth: true,
        render: () => <DownloadPreview busy initial={previewDownload} />,
      },
      {
        id: "failed",
        label: "Download failed",
        fullWidth: true,
        render: () => <DownloadPreview failed initial={previewDownload} />,
      },
    ],
  },
  {
    id: "handoff",
    label: "Task setup",
    kind: "page",
    states: [
      {
        id: "pending",
        label: "Connect account",
        fullWidth: true,
        render: () => <HandoffPreview initial={{ kind: "ready", handoff: previewHandoff }} />,
      },
      ...(["completed", "expired", "abandoned", "invalidated"] as const).map((state) => ({
        fullWidth: true,
        id: state,
        label: state,
        render: () => (
          <HandoffPreview initial={{ kind: "ready", handoff: { ...previewHandoff, state } }} />
        ),
      })),
      ...(["loading", "error", "unavailable"] as const).map((kind) => ({
        fullWidth: true,
        id: kind,
        label: kind,
        render: () => <HandoffPreview initial={{ kind }} />,
      })),
      {
        id: "busy",
        label: "Opening Google",
        fullWidth: true,
        render: () => <HandoffPreview busy initial={{ kind: "ready", handoff: previewHandoff }} />,
      },
      {
        id: "failed",
        label: "Setup failed",
        fullWidth: true,
        render: () => (
          <HandoffPreview failed initial={{ kind: "ready", handoff: previewHandoff }} />
        ),
      },
    ],
  },
  {
    id: "connections",
    label: "Connected apps",
    kind: "page",
    states: [
      {
        id: "empty",
        label: "No accounts",
        fullWidth: true,
        render: () => <ConnectionsPreview initial={{ kind: "ready", connections: [] }} />,
      },
      ...(["ready", "empty", "saving", "error"] as const).map((calendarState) => ({
        id: `calendars-${calendarState}`,
        label: `Calendars · ${calendarState}`,
        fullWidth: true,
        render: () => (
          <ConnectionsPreview
            initial={{ kind: "ready", connections: previewConnections }}
            calendarState={calendarState}
          />
        ),
      })),
      {
        id: "connected",
        label: "Multiple accounts",
        fullWidth: true,
        render: () => (
          <ConnectionsPreview initial={{ kind: "ready", connections: previewConnections }} />
        ),
      },
      {
        id: "loading",
        label: "Loading",
        fullWidth: true,
        render: () => <ConnectionsPreview initial={{ kind: "loading" }} />,
      },
      ...(["reconnect", "disconnected"] as const).map((status) => ({
        id: status,
        label: status === "reconnect" ? "Reconnect required" : "Disconnected",
        fullWidth: true,
        render: () => (
          <ConnectionsPreview
            initial={{
              kind: "ready",
              connections: previewConnections.map((connection) => ({ ...connection, status })),
            }}
          />
        ),
      })),
      {
        id: "error",
        label: "Unavailable",
        fullWidth: true,
        render: () => <ConnectionsPreview initial={{ kind: "error" }} />,
      },
      {
        id: "failed",
        label: "Consent failed",
        fullWidth: true,
        render: () => (
          <ConnectionsPreview initial={{ kind: "ready", connections: [] }} result="failed" />
        ),
      },
      {
        id: "limited",
        label: "Limited access",
        fullWidth: true,
        render: () => (
          <ConnectionsPreview
            initial={{
              kind: "ready",
              connections: previewConnections.map((connection) => ({
                ...connection,
                status: "limited",
              })),
            }}
            result="limited"
          />
        ),
      },
    ],
  },
  {
    id: "telegram",
    label: "Telegram connection",
    kind: "page",
    states: [
      {
        id: "disconnected",
        label: "Disconnected",
        fullWidth: true,
        render: () => <PairingPreview initial={{ kind: "disconnected" }} />,
      },
      {
        id: "waiting",
        label: "Waiting for Telegram",
        fullWidth: true,
        render: () => <PairingPreview initial={{ kind: "waiting", id: "preview" }} />,
      },
      {
        id: "candidate",
        label: "Confirm account",
        fullWidth: true,
        render: () => (
          <PairingPreview
            initial={{ kind: "candidate", id: "preview", userId: "123456", name: "Alex" }}
          />
        ),
      },
      {
        id: "connected",
        label: "Connected",
        fullWidth: true,
        render: () => <PairingPreview initial={{ kind: "connected", userId: "123456" }} />,
      },
      {
        id: "loading",
        label: "Loading",
        fullWidth: true,
        render: () => <PairingPreview initial={{ kind: "loading" }} />,
      },
      {
        id: "error",
        label: "Error",
        fullWidth: true,
        render: () => <PairingPreview initial={{ kind: "error" }} />,
      },
    ],
  },
  {
    id: "sign-in",
    label: "Sign-in",
    kind: "page",
    states: [
      {
        id: "signed-out",
        label: "Signed out",
        fullWidth: true,
        render: () => <SignInPreview initial="signed-out" />,
      },
      {
        id: "loading",
        label: "Loading",
        fullWidth: true,
        render: () => <SignInPreview initial="loading" />,
      },
      {
        id: "redirecting",
        label: "Opening Google",
        fullWidth: true,
        render: () => <SignInPreview initial="redirecting" />,
      },
      {
        id: "error",
        label: "Error",
        fullWidth: true,
        render: () => <SignInPreview initial="error" />,
      },
      {
        id: "signed-in",
        label: "Signed in",
        fullWidth: true,
        render: () => <SignInPreview initial="signed-in" />,
      },
      {
        id: "session-error",
        label: "Session unavailable",
        fullWidth: true,
        render: () => <SignInPreview initial="session-error" />,
      },
    ],
  },
  {
    id: "foundation",
    label: "Component foundation",
    kind: "foundation",
    states: [
      { id: "navigation", label: "Navigation", render: FoundationShell, fullWidth: true },
      { id: "controls", label: "Controls", render: () => <ComponentGallery section="controls" /> },
      { id: "feedback", label: "Feedback", render: () => <ComponentGallery section="feedback" /> },
      { id: "layout", label: "Data & layout", render: () => <ComponentGallery section="layout" /> },
    ],
  },
];

export const reviewViewports = [
  { value: "desktop", label: "Desktop · 1280px", width: 1280 },
  { value: "mobile", label: "Mobile · 390px", width: 390 },
] as const;

export function readReviewSelection(search: string) {
  const query = new URLSearchParams(search);
  const page = reviewPages.find((item) => item.id === query.get("page"));
  const state = page?.states.find((item) => item.id === query.get("state")) ?? page?.states[0];
  const viewport =
    reviewViewports.find((item) => item.value === query.get("viewport")) ?? reviewViewports[0];

  return { page, state, viewport };
}

export function reviewLink(page: string, state: string, viewport = "desktop") {
  return `/__dev/design/pages?${new URLSearchParams({ page, state, viewport }).toString()}`;
}
