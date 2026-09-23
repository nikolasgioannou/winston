import type { createDatabase } from "@winston/adapters/database";
import { createWorkspaceCancellation } from "@winston/adapters/workspace";

export function startCancellationRuntime(options: {
  database: ReturnType<typeof createDatabase>;
  botId: number;
  notice: (code: string) => void;
}) {
  const controller = new AbortController();
  const reconcile = createWorkspaceCancellation({ database: options.database });
  const cursors = new Map<string, string>();
  let ownerCursor: string | undefined;
  let active: Promise<void> | undefined;
  async function pump() {
    const owners = await options.database.telegramOwners(options.botId, ownerCursor);
    ownerCursor = owners.length === 100 ? owners.at(-1) : undefined;
    for (const ownerId of owners) {
      if (controller.signal.aborted) return;
      const next = await reconcile(ownerId, cursors.get(ownerId), controller.signal);
      if (next) cursors.set(ownerId, next);
      else cursors.delete(ownerId);
    }
  }
  const tick = () => {
    if (active || controller.signal.aborted) return;
    active = pump()
      .catch(() => {
        options.notice("workspace-cancellation-check-failed");
      })
      .finally(() => {
        active = undefined;
      });
  };
  const timer = setInterval(tick, 5000);
  tick();
  return {
    async stop() {
      clearInterval(timer);
      controller.abort();
      await active;
    },
  };
}
