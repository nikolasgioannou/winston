import type { GmailOutgoingMessage } from "@winston/contracts/gmail-messages";
import type { createArtifactReader } from "../artifacts";
import type { GmailAttachmentBytes } from "./gmail-message-preparation";

export async function readGmailOutgoingAttachments(
  read: ReturnType<typeof createArtifactReader>,
  ownerId: string,
  attachments: GmailOutgoingMessage["attachments"],
  signal: AbortSignal,
): Promise<GmailAttachmentBytes[]> {
  const result: GmailAttachmentBytes[] = [];
  for (const expected of attachments) {
    const content = await read(ownerId, expected.artifactId, expected.size, signal);
    if (
      !content ||
      content.artifact.id !== expected.artifactId ||
      content.artifact.object.ownerId !== ownerId ||
      content.artifact.state !== "ready" ||
      content.artifact.revision !== expected.revision ||
      content.artifact.metadata.name !== expected.name ||
      content.artifact.metadata.mediaType !== expected.mediaType ||
      content.artifact.metadata.size !== expected.size ||
      content.artifact.metadata.sha256 !== expected.sha256
    )
      throw new Error("Gmail attachment is unavailable or changed.");
    result.push({
      artifactId: expected.artifactId,
      revision: expected.revision,
      bytes: content.bytes,
    });
  }
  return result;
}
