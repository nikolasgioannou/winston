import { useState } from "react";
import { ManagementShell } from "../management/shell";
import { AccountView } from "../management/account-view";
import { SignInView } from "../auth/sign-in-view";
import { PairingView, type PairingState } from "../telegram/pairing-view";
import { ConnectionsPreview } from "./connections-preview";
import { SchedulesPreview, previewSchedules } from "./schedules-preview";

export function ManagementPreview({ initial }: { initial: "/" | "/connections" | "/schedules" }) {
  const [path, setPath] = useState(initial);
  const [signedIn, setSignedIn] = useState(true);
  const [telegram, setTelegram] = useState<PairingState>({ kind: "disconnected" });
  if (!signedIn)
    return (
      <SignInView
        state="signed-out"
        onSignIn={() => {
          setSignedIn(true);
        }}
        onSignOut={() => {}}
        onRetry={() => {}}
      />
    );
  return (
    <ManagementShell
      preview
      activeHref={path}
      onNavigate={(href) => {
        setPath(href === "/connections" || href === "/schedules" ? href : "/");
      }}
    >
      {path === "/schedules" ? (
        <SchedulesPreview embedded initial={{ kind: "ready", items: previewSchedules }} />
      ) : path === "/" ? (
        <AccountView
          onSignOut={() => {
            setSignedIn(false);
          }}
        >
          <PairingView
            state={telegram}
            onConnect={() => {
              setTelegram({ kind: "connected", userId: "123456" });
            }}
            onConfirm={() => {
              setTelegram({ kind: "connected", userId: "123456" });
            }}
            onDisconnect={() => {
              setTelegram({ kind: "disconnected" });
            }}
            onRetry={() => {
              setTelegram({ kind: "disconnected" });
            }}
          />
        </AccountView>
      ) : (
        <>
          <h1 className="text-xl font-medium">Connections</h1>
          <ConnectionsPreview embedded initial={{ kind: "ready", connections: [] }} />
        </>
      )}
    </ManagementShell>
  );
}
