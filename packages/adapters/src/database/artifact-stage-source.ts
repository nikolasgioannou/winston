import {
  artifactStageRequestSchema,
  gmailAttachmentArtifactSchema,
  type ArtifactStageRequest,
} from "@winston/contracts/artifacts";
import { cliReadRequestSchema } from "@winston/contracts/cli";
import type { ActionTask } from "@winston/contracts/actions";
import type { DatabaseTransaction } from "./owners";
import { artifactRepository } from "./artifacts";
import { actionRepository } from "./actions";
import { readGmailAttachmentArtifact } from "../google/gmail-attachment-result";

// Existing intake proof is required; owning an arbitrary artifact ID is insufficient.
export async function authorizedStageSource(
  transaction: DatabaseTransaction,
  ownerId: string,
  worker: ActionTask,
  input: ArtifactStageRequest,
) {
  const request = artifactStageRequestSchema.parse(input);
  const artifacts = artifactRepository(transaction, ownerId);
  const parsed = gmailAttachmentArtifactSchema.safeParse(await artifacts.find(request.id, true));
  if (!parsed.success || parsed.data.state !== "ready" || parsed.data.revision !== request.revision)
    return null;
  const artifact = parsed.data;
  const readActionId = artifact.metadata.source.origin.readActionId;
  const original = await artifacts.findByKey(`gmail-attachment:${readActionId}`);
  if (original?.id !== artifact.id) return null;
  const actions = actionRepository(transaction, ownerId);
  const action = await actions.find(readActionId);
  if (action?.state !== "succeeded") return null;
  const read = cliReadRequestSchema.safeParse(action.request.arguments);
  if (!read.success || read.data.command !== "gmail.attachment") return null;
  if (
    !(await actions.authorizeGmailAttachmentReceipt({
      id: action.id,
      task: worker,
      request: read.data,
    }))
  )
    return null;
  readGmailAttachmentArtifact(artifact, read.data, readActionId);
  return { artifact, readActionId };
}
