import type { DbOrTx } from "@winston/db/client";
import { vms } from "@winston/db/schema";
import { applyVmEvent } from "@winston/db/vm-state";
import { createVm, issueRegistrationToken } from "@winston/db/vms";
import type { Logger } from "@winston/shared/logger";
import { eq } from "drizzle-orm";
import type { JobHandler } from "../worker.ts";
import type { VmProvider } from "./provider.ts";

/**
 * Provisions a user's VM (docs/design.md §15, §17): creates the row if
 * needed, issues a fresh registration token (stored hashed), creates and
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
  const { instanceId, dataVolumeId } = await provider.create({
    userId,
    registrationToken,
  });
  await db
    .update(vms)
    .set({ instanceId, dataVolumeId })
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

/** The `provision_vm` job. */
export function provisionVmHandler(provider: VmProvider): JobHandler {
  return async ({ job, db, logger }) => {
    if (!job.userId) throw new Error("provision_vm job has no user");
    const replace =
      (job.payload as { replace?: unknown } | null)?.replace === true;
    await provisionVm({ db, logger, provider }, job.userId, { replace });
  };
}
