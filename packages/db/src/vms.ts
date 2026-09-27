import { generateToken, hashToken } from "@winston/shared/tokens";
import { eq } from "drizzle-orm";
import type { DbOrTx } from "./client.ts";
import { vms, type vmProvider } from "./schema/index.ts";

/** Creates a user's VM row, in `requested`. */
export async function createVm(
  db: DbOrTx,
  userId: string,
  provider: (typeof vmProvider.enumValues)[number],
) {
  const [vm] = await db.insert(vms).values({ userId, provider }).returning();
  if (!vm) throw new Error("Creating a VM returned no row.");
  return vm;
}

/**
 * Issues a fresh one-time registration token for a VM (docs/design.md §15),
 * replacing any earlier one. Only its hash is stored; the raw token is
 * returned once, to hand to the VM as it's provisioned.
 */
export async function issueRegistrationToken(db: DbOrTx, vmId: string) {
  const token = generateToken();
  await db
    .update(vms)
    .set({ registrationTokenHash: hashToken(token) })
    .where(eq(vms.id, vmId));
  return token;
}
