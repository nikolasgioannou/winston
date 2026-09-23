import { useCallback, useEffect, useRef, useState } from "react";
import { handoffSchema } from "@winston/contracts/handoffs";
import { connectionUrlSchema } from "@winston/contracts/connections";
import { HandoffView, type HandoffState } from "./handoff-view";
import { rememberHandoff } from "./locator";

export function HandoffPage({ id }: { id: string }) {
  const [state, setState] = useState<HandoffState>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(() =>
    ["failed", "limited"].includes(
      new URLSearchParams(window.location.search).get("connection_result") ?? "",
    ),
  );
  const revision = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++revision.current;
    try {
      const response = await fetch(`/api/owner/handoffs/${id}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (current !== revision.current) return;
      if (response.status === 404) {
        setState({ kind: "unavailable" });
        rememberHandoff(null);
        return;
      }
      if (!response.ok) throw new Error();
      const handoff = handoffSchema.parse(await response.json());
      if (current !== revision.current) return;
      setState({ kind: "ready", handoff });
      if (!["pending", "expired"].includes(handoff.state)) rememberHandoff(null);
    } catch {
      if (current === revision.current) setState({ kind: "error" });
    }
  }, [id]);
  useEffect(() => {
    let active = true;
    Promise.resolve()
      .then(() => {
        if (active) return refresh();
      })
      .catch(() => {});
    return () => {
      active = false;
      revision.current += 1;
    };
  }, [refresh]);

  async function act(action: "connect" | "renew" | "abandon") {
    setBusy(true);
    setFailed(false);
    try {
      const response = await fetch(`/api/owner/handoffs/${id}/${action}`, {
        method: "POST",
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error();
      if (action === "connect") {
        const { url } = connectionUrlSchema.parse(await response.json());
        if (new URL(url).origin !== "https://accounts.google.com") throw new Error();
        rememberHandoff(id);
        window.location.assign(url);
      } else await refresh();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <HandoffView
      state={state}
      busy={busy}
      failed={failed}
      onLeave={() => {
        rememberHandoff(null);
      }}
      onAction={(action) => {
        act(action).catch(() => {
          setFailed(true);
        });
      }}
      onRetry={() => {
        refresh().catch(() => {});
      }}
    />
  );
}
