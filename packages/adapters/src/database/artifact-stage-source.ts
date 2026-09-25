import {
  artifactStageRequestSchema,
  type ArtifactStageRequest,
} from "@winston/contracts/artifacts";
import type { ActionTask } from "@winston/contracts/actions";
import type { DatabaseTransaction } from "./owners";
import { artifactRepository } from "./artifacts";
import { actionRepository } from "./actions";
import { artifactSourceProof } from "./artifact-source-proof";

// Existing intake proof is required; owning an arbitrary artifact ID is insufficient.
export async function authorizedStageSource(
  transaction: DatabaseTransaction,
  ownerId: string,
  worker: ActionTask,
  input: ArtifactStageRequest,
) {
  const request = artifactStageRequestSchema.parse(input);
  const artifacts = artifactRepository(transaction, ownerId);
  const artifact = await artifacts.find(request.id, true);
  if (!artifact || artifact.revision !== request.revision) return null;
  const source = await artifactSourceProof(transaction, ownerId, artifact);
  if (!source) return null;
  const actions = actionRepository(transaction, ownerId);
  if (
    !(await actions.authorizeCompletedArtifactReceipt({
      id: source.readActionId,
      taskId: worker.id,
      intentRevision: source.intentRevision,
      worker,
      proof: source.proof,
    }))
  )
    return null;
  return { artifact, readActionId: source.readActionId };
}
