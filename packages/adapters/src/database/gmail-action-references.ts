import type { GmailMutationPlan } from "@winston/contracts/gmail-mutations";
import type { DatabaseTransaction } from "./owners";
import { artifactRepository } from "./artifacts";
import { connectionRepository } from "./connections";
import { connectionTargetRepository } from "./connection-targets";

export async function gmailActionReferencesCurrent(
  transaction: DatabaseTransaction,
  ownerId: string,
  plan: GmailMutationPlan,
) {
  const target = plan.prepared.target;
  const connection = await connectionRepository(transaction, ownerId).find(target.connectionId);
  const preferences = await connectionTargetRepository(transaction, ownerId).preferences();
  if (
    connection?.service !== "gmail" ||
    !["connected", "limited"].includes(connection.status) ||
    connection.revision !== target.connectionRevision ||
    connection.email.toLowerCase() !== target.email.toLowerCase() ||
    preferences.revision !== target.preferencesRevision
  )
    return false;
  const artifacts = artifactRepository(transaction, ownerId);
  for (const attachment of plan.prepared.message.attachments) {
    const artifact = await artifacts.find(attachment.artifactId, true);
    if (
      artifact?.state !== "ready" ||
      artifact.revision !== attachment.revision ||
      artifact.metadata.name !== attachment.name ||
      artifact.metadata.mediaType !== attachment.mediaType ||
      artifact.metadata.size !== attachment.size ||
      artifact.metadata.sha256 !== attachment.sha256
    )
      return false;
  }
  return true;
}
