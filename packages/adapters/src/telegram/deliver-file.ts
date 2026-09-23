import type { OwnerTransaction } from "../database";
import type { createArtifactReader } from "../artifacts";
import { maximumTelegramDocumentBytes, type createTelegramDocumentSender } from "./document";
import type { TelegramSendOutcome } from "./send-result";
import type { createTelegramSender } from "./send";

export async function deliverTelegramFile(
  database: {
    transaction<Result>(
      ownerId: string,
      work: (scope: Pick<OwnerTransaction, "telegramFiles">) => Promise<Result>,
    ): Promise<Result>;
  },
  ownerId: string,
  botId: number,
  read: ReturnType<typeof createArtifactReader>,
  send: ReturnType<typeof createTelegramDocumentSender>,
  signal: AbortSignal,
  fallback?: { webOrigin: string; send: ReturnType<typeof createTelegramSender> },
) {
  signal.throwIfAborted();
  const delivery = await database.transaction(ownerId, ({ telegramFiles }) =>
    telegramFiles.claim(botId),
  );
  if (!delivery) return "idle";
  let dispatch: () => Promise<TelegramSendOutcome>;
  try {
    if (delivery.method === "link") {
      if (!fallback) throw new Error("Download delivery unavailable.");
      const url = new URL(`/files/${delivery.id}`, fallback.webOrigin);
      const text = `${delivery.name}\nDownload: ${url.href}`;
      dispatch = () => fallback.send(delivery.chatId, text, signal);
    } else {
      const file = await read(ownerId, delivery.artifactId, maximumTelegramDocumentBytes, signal);
      if (!file) throw new Error("File unavailable.");
      dispatch = () =>
        send(delivery.chatId, { name: file.artifact.metadata.name, bytes: file.bytes }, signal);
    }
    signal.throwIfAborted();
  } catch {
    await database.transaction(ownerId, ({ telegramFiles }) =>
      telegramFiles.settle(
        delivery,
        signal.aborted ? { state: "retry", afterSeconds: 1 } : { state: "rejected" },
      ),
    );
    return "unavailable";
  }
  const dispatched = await database.transaction(ownerId, ({ telegramFiles }) =>
    telegramFiles.dispatch(delivery),
  );
  if (!dispatched) return "canceled";
  let outcome: TelegramSendOutcome;
  try {
    outcome = await dispatch();
  } catch {
    outcome = { state: "uncertain" };
  }
  const settled = await database.transaction(ownerId, ({ telegramFiles }) =>
    telegramFiles.settle(delivery, outcome),
  );
  return settled ? outcome.state : "lease-lost";
}
