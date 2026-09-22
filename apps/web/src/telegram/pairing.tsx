import { useCallback, useEffect, useRef, useState } from "react";
import { telegramChallengeSchema, telegramStatusSchema } from "@winston/contracts/telegram";
import { PairingView, type PairingState } from "./pairing-view";

export function TelegramPairing() {
  const [state, setState] = useState<PairingState>({ kind: "loading" });
  const revision = useRef(0);

  const refresh = useCallback(async () => {
    const current = ++revision.current;

    try {
      const response = await fetch("/api/owner/telegram", { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error("Telegram unavailable.");
      const data = telegramStatusSchema.parse(await response.json());
      if (current !== revision.current) return;

      setState((previous) => {
        if (data.challenge?.userId)
          return {
            kind: "candidate",
            id: data.challenge.id,
            userId: data.challenge.userId,
            name: data.challenge.name ?? "Telegram account",
          };
        if (data.challenge)
          return {
            kind: "waiting",
            id: data.challenge.id,
            ...(previous.kind === "waiting" && previous.id === data.challenge.id && previous.url
              ? { url: previous.url }
              : {}),
          };
        if (data.binding) return { kind: "connected", userId: data.binding.userId };

        return { kind: "disconnected" };
      });
    } catch {
      if (current === revision.current) setState({ kind: "error" });
    }
  }, []);

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

  useEffect(() => {
    if (state.kind !== "waiting") return;
    let running = false;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible" || running) return;
      running = true;
      refresh()
        .finally(() => {
          running = false;
        })
        .catch(() => {});
    }, 2000);

    return () => {
      window.clearInterval(timer);
    };
  }, [state.kind, refresh]);

  async function act(action: "challenge" | "confirm" | "disconnect") {
    const current = ++revision.current;
    const id = state.kind === "candidate" ? state.id : undefined;
    setState({ kind: "loading" });

    try {
      const response = await fetch(
        `/api/owner/telegram${action === "disconnect" ? "" : `/${action}`}`,
        {
          method: action === "disconnect" ? "DELETE" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(action === "confirm" ? { id } : {}),
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!response.ok) throw new Error("Telegram action failed.");
      if (current !== revision.current) return;

      if (action === "challenge") {
        const challenge = telegramChallengeSchema.parse(await response.json());
        if (current === revision.current) setState({ kind: "waiting", ...challenge });
      } else {
        await refresh();
      }
    } catch {
      if (current === revision.current) setState({ kind: "error" });
    }
  }

  return (
    <PairingView
      state={state}
      onConnect={() => {
        act("challenge").catch(() => {});
      }}
      onConfirm={() => {
        act("confirm").catch(() => {});
      }}
      onDisconnect={() => {
        act("disconnect").catch(() => {});
      }}
      onRetry={() => {
        refresh().catch(() => {});
      }}
    />
  );
}
