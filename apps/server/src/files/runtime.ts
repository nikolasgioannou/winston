import type { createDatabase } from "@winston/adapters/database";
import type { createArtifactReader } from "@winston/adapters/artifacts";
import { createTelegramDocumentSender, deliverTelegramFile } from "@winston/adapters/telegram";
import { startOwnerFileLoop } from "./owner-loop";

export function startFileDeliveryRuntime(options: {
  database: ReturnType<typeof createDatabase>;
  botId: number;
  token: string;
  read: ReturnType<typeof createArtifactReader>;
  notice: (code: string) => void;
}) {
  const send = createTelegramDocumentSender(options.token);
  return startOwnerFileLoop({
    ...options,
    async run(ownerId, signal) {
      const outcome = await deliverTelegramFile(
        options.database,
        ownerId,
        options.botId,
        options.read,
        send,
        signal,
      );
      if (["uncertain", "unavailable", "rejected", "lease-lost"].includes(outcome))
        options.notice(`telegram-file-${outcome}`);
    },
    failed: () => {
      options.notice("telegram-file-delivery-failed");
    },
  });
}
