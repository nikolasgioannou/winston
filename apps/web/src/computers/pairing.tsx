import { useEffect, useRef, useState } from "react";
import { devicePairingChallengeSchema } from "@winston/contracts/device-registry";
import { ownerJson } from "../management/api";
import { DevicePairingView, type DevicePairingState } from "./pairing-view";

export function DevicePairing({ onRefresh }: { onRefresh: () => void }) {
  const [state, setState] = useState<DevicePairingState>({ kind: "closed" });
  const revision = useRef(0);
  const busy = useRef(false);

  useEffect(
    () => () => {
      revision.current += 1;
    },
    [],
  );

  useEffect(() => {
    if (state.kind !== "code") return;
    const timer = window.setTimeout(
      () => {
        setState({ kind: "expired" });
      },
      Math.max(0, Math.min(300_000, Date.parse(state.challenge.expiresAt) - Date.now())),
    );
    return () => {
      window.clearTimeout(timer);
    };
  }, [state]);

  async function create(name: string) {
    if (busy.current) return;
    busy.current = true;
    const current = ++revision.current;
    setState({ kind: "creating" });
    try {
      const challenge = await ownerJson(
        "/api/owner/devices/pairing",
        devicePairingChallengeSchema,
        {
          method: "POST",
          body: { name },
        },
      );
      if (current !== revision.current) return;
      setState(
        Date.parse(challenge.expiresAt) <= Date.now()
          ? { kind: "expired" }
          : { kind: "code", challenge },
      );
    } catch {
      if (current === revision.current) setState({ kind: "error" });
    } finally {
      busy.current = false;
    }
  }

  async function close() {
    if (busy.current) return;
    const id =
      state.kind === "code" ? state.challenge.id : state.kind === "cancel-error" ? state.id : null;
    if (!id) {
      setState({ kind: "closed" });
      return;
    }
    busy.current = true;
    const current = ++revision.current;
    setState({ kind: "closing" });
    try {
      const response = await fetch(`/api/owner/devices/pairing/${id}`, {
        method: "DELETE",
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error("Cancellation failed.");
      if (current !== revision.current) return;
      setState({ kind: "closed" });
      onRefresh();
    } catch {
      if (current === revision.current) setState({ kind: "cancel-error", id });
    } finally {
      busy.current = false;
    }
  }

  return (
    <DevicePairingView
      state={state}
      onOpen={() => {
        setState({ kind: "form" });
      }}
      onCreate={(name) => {
        create(name).catch(() => {});
      }}
      onClose={() => {
        close().catch(() => {});
      }}
    />
  );
}
