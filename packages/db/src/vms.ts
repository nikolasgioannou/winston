import { generateToken, hashToken } from "@winston/shared/tokens";
import type { DbOrTx } from "./client.ts";
import { vms, type vmProvider } from "./schema/index.ts";

/**
 * Creates a user's VM row in `requested`, with a fresh one-time registration
 * token (docs/design.md §15). Only the token's hash is stored; the raw token
 * is returned once, to hand to the VM as it's provisioned.
 */
export async function createVm(
  db: DbOrTx,
  userId: string,
  provider: (typeof vmProvider.enumValues)[number],
) {
  const registrationToken = generateToken();
  const [vm] = await db
    .insert(vms)
    .values({
      userId,
      provider,
      registrationTokenHash: hashToken(registrationToken),
    })
    .returning();
  if (!vm) throw new Error("Creating a VM returned no row.");
  return { vm, registrationToken };
}
