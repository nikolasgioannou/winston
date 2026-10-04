import { useRouter } from "@tanstack/react-router";
import type { ConnectionDto } from "@winston/db/connections";
import type { Capability } from "@winston/domain/connections";
import { toast } from "@winston/ui";
import { useRef, useState } from "react";
import { setAccountCapability } from "../server/accounts-functions";

/** A copy of `record` without `key`. */
function without<T extends object>(record: T, key: keyof T): T {
  return Object.fromEntries(
    Object.entries(record).filter(([name]) => name !== key),
  ) as T;
}

/**
 * Capability toggles that save as they change, quietly: a switch shows its
 * new value at once, and only a failure says anything (it snaps back, with a
 * toast). A switch flipped again before its save lands keeps showing the
 * latest flip: an older save never undoes it, and saves reach the server in
 * the order they were made.
 */
export function useCapabilitySaves(account: ConnectionDto | null) {
  const router = useRouter();
  const [pending, setPending] = useState<Partial<Record<Capability, boolean>>>(
    {},
  );
  // The latest flip of each switch, so only its save settles the switch.
  const latest = useRef<Partial<Record<Capability, number>>>({});
  // Each switch's saves, in order, so the server ends on its last flip.
  const saving = useRef<Partial<Record<Capability, Promise<unknown>>>>({});

  const toggle = async (capability: Capability, enabled: boolean) => {
    if (!account) return;
    const flip = (latest.current[capability] ?? 0) + 1;
    latest.current[capability] = flip;
    setPending((p) => ({ ...p, [capability]: enabled }));
    const save = (saving.current[capability] ?? Promise.resolve())
      .catch(() => undefined)
      .then(() =>
        setAccountCapability({ data: { id: account.id, capability, enabled } }),
      );
    saving.current[capability] = save;
    try {
      await save;
      if (latest.current[capability] !== flip) return;
      // Waits for the loaders to rerun, so the switch never shows stale data.
      await router.invalidate({ sync: true });
    } catch {
      if (latest.current[capability] !== flip) return;
      toast.error("Couldn't save that change. Please try again.");
      // Snaps back to what the server has, which an earlier flip may have set.
      await router.invalidate({ sync: true }).catch(() => undefined);
    }
    if (latest.current[capability] === flip)
      setPending((p) => without(p, capability));
  };

  return { capabilities: { ...account?.capabilities, ...pending }, toggle };
}
