import { timestampSnapshot } from "../timezone";
import { userMessageSchema, type UserMessage } from "./schema";

export { autonomousEventSchema, metadataSchema, userMessageSchema } from "./schema";
export type { AutonomousEvent, MessageMetadata, UserMessage } from "./schema";
export { serializeAutonomousEvent, serializeUserMessage } from "./serialize";

type MessageReceipt = Omit<UserMessage, "version" | "kind" | "revision" | "sentAt">;

// Ingress supplies its first-receipt clock and persisted owner zone once, then stores the result.
export function createUserMessage(receipt: MessageReceipt, receivedAt: Date, timezone: string) {
  return userMessageSchema.parse({
    ...receipt,
    version: 1,
    kind: "user-message",
    revision: 0,
    sentAt: timestampSnapshot(receivedAt, timezone),
  });
}

// Call only after the scoped staging/transcription service has verified the new metadata.
// Database callers must also perform revision comparison and replacement atomically.
export function acceptMessageRevision(currentInput: unknown, nextInput: unknown) {
  const current = userMessageSchema.parse(currentInput);
  const next = userMessageSchema.parse(nextInput);
  const { revision: currentRevision, metadata: currentMetadata, ...currentReceipt } = current;
  const { revision: nextRevision, metadata: nextMetadata, ...nextReceipt } = next;

  if (JSON.stringify(currentReceipt) !== JSON.stringify(nextReceipt)) {
    throw new Error("Message revisions cannot change the original receipt.");
  }
  if (
    nextRevision === currentRevision &&
    JSON.stringify(currentMetadata) === JSON.stringify(nextMetadata)
  ) {
    return current;
  }
  if (nextRevision !== currentRevision + 1) {
    throw new Error("Message revision is stale, conflicting, or out of order.");
  }

  return next;
}
