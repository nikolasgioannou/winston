import type { createDatabase } from "@winston/adapters/database";

export function startOwnerFileLoop(options: {
  database: Pick<ReturnType<typeof createDatabase>, "telegramOwners">;
  botId: number;
  run: (ownerId: string, signal: AbortSignal) => Promise<unknown>;
  failed: () => void;
}) {
  const shutdown = new AbortController();
  const transfers = new Map<string, Promise<void>>();
  let cursor: string | undefined;
  let active: Promise<void> | undefined;

  async function pump() {
    if (transfers.size >= 2) return;
    let owners = await options.database.telegramOwners(options.botId, cursor);
    if (owners.length === 0 && cursor !== undefined) {
      cursor = undefined;
      owners = await options.database.telegramOwners(options.botId);
    }
    for (const ownerId of owners) {
      if (shutdown.signal.aborted || transfers.size >= 2) return;
      // Resume after the last visited owner, not the start or end of an unprocessed page.
      cursor = ownerId;
      if (transfers.has(ownerId)) continue;
      const transfer = options
        .run(ownerId, shutdown.signal)
        .then(() => undefined)
        .catch(options.failed)
        .finally(() => {
          transfers.delete(ownerId);
        });
      transfers.set(ownerId, transfer);
    }
  }

  const tick = () => {
    if (active || shutdown.signal.aborted) return;
    active = pump()
      .catch(options.failed)
      .finally(() => {
        active = undefined;
      });
  };
  const timer = setInterval(tick, 500);
  tick();
  return {
    async stop() {
      clearInterval(timer);
      shutdown.abort();
      await active;
      await Promise.all(transfers.values());
    },
  };
}
