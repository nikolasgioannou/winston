import type { OwnerTransaction } from "../database";
import type { createArtifactReader } from "../artifacts";
import { maximumTelegramDocumentBytes, type createTelegramDocumentSender } from "./document";
import type { TelegramSendOutcome } from "./send-result";

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
) {
  signal.throwIfAborted();
  const delivery = await database.transaction(ownerId, ({ telegramFiles }) =>
    telegramFiles.claim(botId),
  );
  if (!delivery) return "idle";
  let file: Awaited<ReturnType<typeof read>>;
  try {
    file = await read(ownerId, delivery.artifactId, maximumTelegramDocumentBytes, signal);
  } catch {
    await database.transaction(ownerId, ({ telegramFiles }) =>
      telegramFiles.settle(
        delivery,
        signal.aborted ? { state: "retry", afterSeconds: 1 } : { state: "rejected" },
      ),
    );
    return "unavailable";
  }
  if (!file || signal.aborted) {
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
    outcome = await send(
      delivery.chatId,
      { name: file.artifact.metadata.name, bytes: file.bytes },
      signal,
    );
  } catch {
    outcome = { state: "uncertain" };
  }
  const settled = await database.transaction(ownerId, ({ telegramFiles }) =>
    telegramFiles.settle(delivery, outcome),
  );
  return settled ? outcome.state : "lease-lost";
}
