import { provisionVmJob } from "@winston/domain/jobs";
import { generateToken, hashToken } from "@winston/shared/tokens";
import { and, eq, inArray } from "drizzle-orm";
import type { DbOrTx } from "./client.ts";
import { enqueue } from "./queue.ts";
import { jobs, vms, type vmProvider } from "./schema/index.ts";
import { applyVmEvent, type VmState } from "./vm-state.ts";

/** Creates a user's VM row, in `requested`. */
export async function createVm(
  db: DbOrTx,
  userId: string,
  provider?: (typeof vmProvider.enumValues)[number],
) {
  const [vm] = await db.insert(vms).values({ userId, provider }).returning();
  if (!vm) throw new Error("Creating a VM returned no row.");
  return vm;
}

const queueProvisioning = (
  db: DbOrTx,
  userId: string,
  options: { delayMs?: number } = {},
) =>
  enqueue(db, provisionVmJob.type, {
    userId,
    dedupeKey: provisionVmJob.dedupeKey(userId),
    maxAttempts: provisionVmJob.maxAttempts,
    ...options,
  });

/**
 * Gives a user a computer (docs/design.md §17): creates their VM row in
 * `requested` and queues `provision_vm`, together. Does nothing when they
 * already have one, so it's safe on every sign-in. Returns whether it
 * requested one.
 */
export async function requestVm(db: DbOrTx, userId: string) {
  return db.transaction(async (tx) => {
    const [vm] = await tx
      .insert(vms)
      .values({ userId })
      .onConflictDoNothing({ target: vms.userId })
      .returning({ id: vms.id });
    if (!vm) return false;
    await queueProvisioning(tx, userId);
    return true;
  });
}

/**
 * Records that a VM's setup failed (it timed out, or provisioning ran out of
 * attempts): the VM becomes `failed`, and it's retried automatically, after a
 * growing wait, until it has failed `provisionVmJob.autoRetries` times in a
 * row. After that it waits for the user's retry. Returns the new failure
 * count and whether a retry was queued. Throws if the VM isn't in setup.
 */
export async function failVmSetup(db: DbOrTx, vmId: string) {
  return db.transaction(async (tx) => {
    await applyVmEvent(tx, vmId, "setup_failed");
    const [vm] = await tx
      .select({ userId: vms.userId, setupFailures: vms.setupFailures })
      .from(vms)
      .where(eq(vms.id, vmId));
    if (!vm) throw new Error(`No VM ${vmId}`);
    const failures = vm.setupFailures + 1;
    await tx
      .update(vms)
      .set({ setupFailures: failures })
      .where(eq(vms.id, vmId));
    const retrying = failures <= provisionVmJob.autoRetries;
    if (retrying)
      await queueProvisioning(tx, vm.userId, {
        delayMs: provisionVmJob.autoRetryDelayMs * failures,
      });
    return { failures, retrying };
  });
}

/**
 * Queues provisioning again for a user's failed VM: the retry button.
 * Returns false when the VM isn't `failed`.
 */
export async function retryFailedVm(db: DbOrTx, userId: string) {
  const [vm] = await db
    .select({ state: vms.state })
    .from(vms)
    .where(eq(vms.userId, userId));
  if (vm?.state !== "failed") return false;
  await queueProvisioning(db, userId);
  return true;
}

/** How a user's computer is doing, as the web app shows it. */
export type ComputerStatus = "setting_up" | "ready" | "unreachable" | "failed";

/**
 * A user's computer status, or null when they have none: setting up covers
 * requested, provisioning and registering, and a failed VM with a retry on
 * the way; an updating VM counts as ready.
 */
export async function computerStatus(
  db: DbOrTx,
  userId: string,
): Promise<ComputerStatus | null> {
  const [vm] = await db
    .select({ state: vms.state })
    .from(vms)
    .where(eq(vms.userId, userId));
  if (!vm) return null;
  if (vm.state === "failed") {
    const [pending] = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.dedupeKey, provisionVmJob.dedupeKey(userId)),
          inArray(jobs.status, ["queued", "running"]),
        ),
      );
    return pending ? "setting_up" : "failed";
  }
  return statusOf[vm.state];
}

const statusOf: Record<VmState, ComputerStatus | null> = {
  requested: "setting_up",
  provisioning: "setting_up",
  registering: "setting_up",
  ready: "ready",
  updating: "ready",
  unhealthy: "unreachable",
  failed: "failed",
  terminating: null,
  terminated: null,
};

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
