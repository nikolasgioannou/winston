import { createFileRoute, useRouter } from "@tanstack/react-router";
import type { Capability } from "@winston/domain/connections";
import { toast } from "@winston/ui";
import { useState } from "react";
import { AccountPage, type SaveState } from "../../../pages/account-page";
import {
  disconnectAccount,
  getAccount,
  setAccountCapability,
} from "../../../server/accounts-functions";

/** A copy of `record` without `key`. */
function without<T extends object>(record: T, key: keyof T): T {
  return Object.fromEntries(
    Object.entries(record).filter(([name]) => name !== key),
  ) as T;
}

/** How long "Saved" shows after a toggle. */
const savedForMs = 2_000;

export const Route = createFileRoute("/_authed/accounts/$accountId")({
  loader: ({ params }) => getAccount({ data: { id: params.accountId } }),
  component: Account,
});

function Account() {
  const { account, unavailable } = Route.useLoaderData();
  const router = useRouter();
  // Toggles show their new value while saving (and snap back on failure).
  const [pending, setPending] = useState<Partial<Record<Capability, boolean>>>(
    {},
  );
  const [saves, setSaves] = useState<Partial<Record<Capability, SaveState>>>(
    {},
  );

  const toggle = async (capability: Capability, enabled: boolean) => {
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

  return (
    <AccountPage
      account={account}
      unavailable={unavailable}
      capabilities={{ ...account.capabilities, ...pending }}
      saves={saves}
      onToggle={(capability, enabled) => void toggle(capability, enabled)}
      onDisconnect={() => {
        void disconnectAccount({ data: { id: account.id } })
          .then(async () => {
            await router.invalidate();
            toast.success(`Disconnected ${account.externalEmail}`);
          })
          .catch(() => {
            toast.error("Couldn't disconnect. Please try again.");
          });
      }}
    />
  );
}
