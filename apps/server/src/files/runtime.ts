import type { createDatabase } from "@winston/adapters/database";
import type { createArtifactReader } from "@winston/adapters/artifacts";
import { createTelegramDocumentSender, deliverTelegramFile } from "@winston/adapters/telegram";

export function startFileDeliveryRuntime(options: {
  database: ReturnType<typeof createDatabase>;
  botId: number;
  token: string;
  read: ReturnType<typeof createArtifactReader>;
  notice: (code: string) => void;
}) {
  const shutdown = new AbortController();
  const send = createTelegramDocumentSender(options.token);
  const deliveries = new Map<string, Promise<void>>();
  let cursor: string | undefined;
  let active: Promise<void> | undefined;
  async function pump() {
    const owners = await options.database.telegramOwners(options.botId, cursor);
    cursor = owners.length === 100 ? owners.at(-1) : undefined;
    for (const ownerId of owners) {
      if (shutdown.signal.aborted) return;
      if (deliveries.has(ownerId) || deliveries.size >= 2) continue;
      const delivery = deliverTelegramFile(
        options.database,
        ownerId,
        options.botId,
        options.read,
        send,
        shutdown.signal,
      )
        .then((outcome) => {
          if (["uncertain", "unavailable", "rejected", "lease-lost"].includes(outcome))
            options.notice(`telegram-file-${outcome}`);
        })
        .catch(() => {
          options.notice("telegram-file-delivery-failed");
        })
        .finally(() => {
          deliveries.delete(ownerId);
        });
      deliveries.set(ownerId, delivery);
    }
  }
  const tick = () => {
    if (active || shutdown.signal.aborted) return;
    active = pump()
      .catch(() => {
        options.notice("telegram-file-pump-failed");
      })
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
      await Promise.all(deliveries.values());
    },
  };
}
