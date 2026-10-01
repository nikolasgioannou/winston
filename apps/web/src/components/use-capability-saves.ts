import { useRouter } from "@tanstack/react-router";
import type { ConnectionDto } from "@winston/db/connections";
import type { Capability } from "@winston/domain/connections";
import { useState } from "react";
import type { SaveState } from "../pages/account-dialog";
import { setAccountCapability } from "../server/accounts-functions";

/** How long "Saved" shows after a toggle. */
const savedForMs = 2_000;

/** A copy of `record` without `key`. */
function without<T extends object>(record: T, key: keyof T): T {
  return Object.fromEntries(
    Object.entries(record).filter(([name]) => name !== key),
  ) as T;
}

/**
 * Capability toggles that save as they change: each shows its new value while
 * saving, then "Saved" for a moment, or snaps back with an error.
 */
export function useCapabilitySaves(account: ConnectionDto | null) {
  const router = useRouter();
  const [pending, setPending] = useState<Partial<Record<Capability, boolean>>>(
    {},
  );
  const [saves, setSaves] = useState<Partial<Record<Capability, SaveState>>>(
    {},
  );

  const toggle = async (capability: Capability, enabled: boolean) => {
    if (!account) return;
    setPending((p) => ({ ...p, [capability]: enabled }));
    setSaves((s) => ({ ...s, [capability]: "saving" }));
    let saved: SaveState = "saved";
    try {
      await setAccountCapability({
        data: { id: account.id, capability, enabled },
      });
      await router.invalidate();
    } catch {
      saved = "error";
    }
    setPending((p) => without(p, capability));
    setSaves((s) => ({ ...s, [capability]: saved }));
    if (saved === "saved")
      setTimeout(() => {
        setSaves((s) =>
          s[capability] === "saved" ? without(s, capability) : s,
        );
      }, savedForMs);
  };

  return {
    capabilities: { ...account?.capabilities, ...pending },
    saves,
    toggle,
  };
}
