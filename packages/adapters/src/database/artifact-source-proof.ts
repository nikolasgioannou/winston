import {
  deviceFileArtifactSchema,
  gmailAttachmentArtifactSchema,
  type Artifact,
} from "@winston/contracts/artifacts";
import { cliReadRequestSchema } from "@winston/contracts/cli";
import type { DatabaseTransaction } from "./owners";
import { actionRepository } from "./actions";
import { artifactRepository } from "./artifacts";
import { readGmailAttachmentArtifact } from "../google/gmail-attachment-result";

export async function artifactSourceProof(
  transaction: DatabaseTransaction,
  ownerId: string,
  artifact: Artifact,
) {
  if (artifact.state !== "ready") return null;
  const gmail = gmailAttachmentArtifactSchema.safeParse(artifact);
  const device = deviceFileArtifactSchema.safeParse(artifact);
  const source = gmail.success ? gmail.data : device.success ? device.data : null;
  if (!source) return null;
  const readActionId = source.metadata.source.origin.readActionId;
  const prefix = gmail.success ? "gmail-attachment" : "device-file";
  const original = await artifactRepository(transaction, ownerId).findByKey(
    `${prefix}:${readActionId}`,
  );
  if (original?.id !== artifact.id) return null;
  const action = await actionRepository(transaction, ownerId).find(readActionId);
  if (action?.state !== "succeeded") return null;

  if (gmail.success) {
    const read = cliReadRequestSchema.safeParse(action.request.arguments);
    if (!read.success || read.data.command !== "gmail.attachment") return null;
    try {
      readGmailAttachmentArtifact(gmail.data, read.data, readActionId);
    } catch {
      return null;
    }
    return {
      artifact: source,
      readActionId,
      intentRevision: action.intentRevision,
      proof: { kind: "source" as const, request: read.data },
    };
  }
  if (!device.success) return null;
  const { origin, reference } = device.data.metadata.source;
  if (reference !== `device:${origin.deviceId}:${origin.executionId}`) return null;
  return {
    artifact: source,
    readActionId,
    intentRevision: action.intentRevision,
    proof: { kind: "device-source" as const, origin },
  };
}
