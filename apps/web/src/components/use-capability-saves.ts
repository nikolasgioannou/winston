import { useRouter } from "@tanstack/react-router";
import type { ConnectionDto } from "@winston/db/connections";
import type { Capability } from "@winston/domain/connections";
import { toast } from "@winston/ui";
import { useState } from "react";
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
 * toast).
 */
export function useCapabilitySaves(account: ConnectionDto | null) {
  const router = useRouter();
  const [pending, setPending] = useState<Partial<Record<Capability, boolean>>>(
    {},
  );

  const toggle = async (capability: Capability, enabled: boolean) => {
    if (!account) return;
    setPending((p) => ({ ...p, [capability]: enabled }));
    try {
      await setAccountCapability({
        data: { id: account.id, capability, enabled },
      });
      await router.invalidate();
    } catch {
      toast.error("Couldn't save that change. Please try again.");
    }
    setPending((p) => without(p, capability));
  };

  return { capabilities: { ...account?.capabilities, ...pending }, toggle };
}
