import type { ResolvedTarget } from "@winston/contracts/connection-targets";
import type { DatabaseTransaction } from "./owners";
import { connectionRepository } from "./connections";
import { connectionTargetRepository } from "./connection-targets";

export async function gmailStateTargetCurrent(
  transaction: DatabaseTransaction,
  ownerId: string,
  target: ResolvedTarget,
) {
  const connection = await connectionRepository(transaction, ownerId).find(target.connectionId);
  const preferences = await connectionTargetRepository(transaction, ownerId).preferences();
  return (
    connection?.service === "gmail" &&
    ["connected", "limited"].includes(connection.status) &&
    connection.revision === target.connectionRevision &&
    connection.email.toLowerCase() === target.email.toLowerCase() &&
    preferences.revision === target.preferencesRevision
  );
}
