import type { DbOrTx } from "@winston/db/client";
import { vms } from "@winston/db/schema";
import { applyVmEvent } from "@winston/db/vm-state";
import { createVm, failVmSetup, issueRegistrationToken } from "@winston/db/vms";
import type { Logger } from "@winston/shared/logger";
import { eq } from "drizzle-orm";
import type { JobHandler } from "../worker.ts";
import type { VmProvider } from "./provider.ts";

/**
 * Provisions a user's VM (docs/design.md §15, §17): creates the row if
 * needed (sign-up normally has), issues a fresh registration token (stored hashed), creates and
 * starts the instance, and leaves the VM `registering` until `winstond`
 * connects. Safe to retry: it resumes from `provisioning` and replaces a
 * half-created instance.
 */
export async function provisionVm(
  {
    db,
    logger,
    provider,
  }: { db: DbOrTx; logger: Logger; provider: VmProvider },
  userId: string,
  options: { replace?: boolean } = {},
) {
  const [existing] = await db.select().from(vms).where(eq(vms.userId, userId));
  const vm = existing ?? (await createVm(db, userId, provider.kind));

  const replacing =
    options.replace === true &&
    (vm.state === "ready" || vm.state === "unhealthy" || vm.state === "failed");
  if (replacing) {
    // A new instance on the same data volume (§17 `replace`): the old one goes,
    // and so does its VM token, so nothing left of it could reconnect.
    await applyVmEvent(db, vm.id, "replace");
    if (vm.instanceId) await provider.destroy(vm.instanceId);
    await db
      .update(vms)
      .set({ tokenHash: null, instanceId: null })
      .where(eq(vms.id, vm.id));
  } else if (vm.state === "requested")
    await applyVmEvent(db, vm.id, "provision");
  else if (vm.state === "failed") await applyVmEvent(db, vm.id, "retry");
  else if (vm.state !== "provisioning") {
    logger.info(
      { vmId: vm.id, state: vm.state },
      "VM already provisioned; nothing to do",
    );
    return;
  }

  const registrationToken = await issueRegistrationToken(db, vm.id);
  // The VM's known data volume, if it has one, so a replacement or a restore
  // attaches exactly that volume.
  const [current] = await db
    .select({ dataVolumeId: vms.dataVolumeId })
    .from(vms)
    .where(eq(vms.id, vm.id));
  const { instanceId, dataVolumeId, imageId } = await provider.create({
    userId,
    registrationToken,
    dataVolumeId: current?.dataVolumeId ?? undefined,
  });
  await db
    .update(vms)
    .set({ provider: provider.kind, instanceId, dataVolumeId, imageId })
    .where(eq(vms.id, vm.id));
  // Registering before the instance starts, so a fast-booting winstond never
  // finds the VM still provisioning.
  await applyVmEvent(db, vm.id, "provisioned");
  await provider.start(instanceId);
  logger.info(
    { vmId: vm.id, instanceId },
    "VM started; waiting for winstond to register",
  );
}

/** VM states a restore may start from: anything else is mid-setup or going away. */
const restorable = new Set(["ready", "unhealthy", "failed"]);

/**
 * Restores a user's VM from its latest data-volume snapshot
 * (docs/runbooks/vm-recovery.md): a new volume from the snapshot, then the
 * usual replacement (a new instance and registration token, the old instance
 * and VM token gone) on that volume. The volume it replaces is deleted once
 * free; its snapshots stay until the snapshot policy expires them.
 */
export async function restoreVm(
  deps: { db: DbOrTx; logger: Logger; provider: VmProvider },
  userId: string,
) {
  const { db, logger, provider } = deps;
  const [vm] = await db.select().from(vms).where(eq(vms.userId, userId));
  if (!vm) throw new Error(`${userId} has no VM to restore.`);
  if (!restorable.has(vm.state))
    throw new Error(
      `${userId}'s VM is ${vm.state}; restore only a ready, unhealthy or failed VM.`,
    );
  const restored = await provider.restoreDataVolume(userId);
  logger.info(
    {
      vmId: vm.id,
      snapshotId: restored.snapshotId,
      snapshotTakenAt: restored.snapshotTakenAt,
      dataVolumeId: restored.dataVolumeId,
    },
    "restoring the VM from its latest snapshot",
  );
  await db
    .update(vms)
    .set({ dataVolumeId: restored.dataVolumeId })
    .where(eq(vms.id, vm.id));
  await provisionVm(deps, userId, { replace: true });
  if (vm.dataVolumeId && vm.dataVolumeId !== restored.dataVolumeId)
    await provider.retireDataVolume(vm.dataVolumeId);
}

/** The `restore_vm` job (`bun run prod vm:restore <email>`). */
export function restoreVmHandler(provider: VmProvider): JobHandler {
  return async ({ job, db, logger }) => {
    const userId = job.userId;
    if (!userId) throw new Error("restore_vm job has no user");
    await restoreVm({ db, logger, provider }, userId);
  };
}

/**
 * The `provision_vm` job. When its last attempt fails, the VM's setup has
 * failed: `failVmSetup` marks it and decides whether to retry automatically.
 */
export function provisionVmHandler(provider: VmProvider): JobHandler {
  return async ({ job, db, logger }) => {
    const userId = job.userId;
    if (!userId) throw new Error("provision_vm job has no user");
    const replace =
      (job.payload as { replace?: unknown } | null)?.replace === true;
    try {
      await provisionVm({ db, logger, provider }, userId, { replace });
    } catch (error) {
      if (job.attempts >= job.maxAttempts)
        await markSetupFailed(db, logger, userId);
      throw error;
    }
  };
}

async function markSetupFailed(db: DbOrTx, logger: Logger, userId: string) {
  const [vm] = await db
    .select({ id: vms.id, state: vms.state })
    .from(vms)
    .where(eq(vms.userId, userId));
  if (vm?.state !== "provisioning" && vm?.state !== "registering") return;
  const { failures, retrying } = await failVmSetup(db, vm.id);
  logger.warn({ vmId: vm.id, failures, retrying }, "VM setup failed");
}
