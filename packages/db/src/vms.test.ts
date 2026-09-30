import { describe, expect, test } from "bun:test";
import { provisionVmJob } from "@winston/domain/jobs";
import { eq, sql } from "drizzle-orm";
import type { DbOrTx } from "./client.ts";
import { jobs, vms } from "./schema/index.ts";
import { inRollback, insertUser, testDb } from "./testing.ts";
import { applyVmEvent } from "./vm-state.ts";
import {
  computerStatus,
  failVmSetup,
  requestVm,
  retryFailedVm,
} from "./vms.ts";

const db = await testDb();

const vmOf = async (tx: DbOrTx, userId: string) => {
  const [vm] = await tx.select().from(vms).where(eq(vms.userId, userId));
  if (!vm) throw new Error("expected a VM");
  return vm;
};

const jobsOf = (tx: DbOrTx, userId: string) =>
  tx
    .select({
      type: jobs.type,
      status: jobs.status,
      maxAttempts: jobs.maxAttempts,
      delaySeconds: sql<number>`round(extract(epoch from ${jobs.runAt} - now()))::int`,
    })
    .from(jobs)
    .where(eq(jobs.userId, userId));

/** Sets a queued job aside, as if the worker took it. */
const takeJobs = (tx: DbOrTx, userId: string) =>
  tx.update(jobs).set({ status: "done" }).where(eq(jobs.userId, userId));

/** A VM that's requested and whose provisioning is under way. */
async function provisioningVm(tx: DbOrTx) {
  const user = await insertUser(tx);
  await requestVm(tx, user.id);
  await takeJobs(tx, user.id);
  const vm = await vmOf(tx, user.id);
  await applyVmEvent(tx, vm.id, "provision");
  return { userId: user.id, vmId: vm.id };
}

describe("requestVm", () => {
  test("creates one requested VM and one provisioning job, once", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      expect(await requestVm(tx, user.id)).toBe(true);
      expect(await requestVm(tx, user.id)).toBe(false);
      expect(await vmOf(tx, user.id)).toMatchObject({
        state: "requested",
        provider: null,
        setupFailures: 0,
      });
      expect(await jobsOf(tx, user.id)).toEqual([
        {
          type: "provision_vm",
          status: "queued",
          maxAttempts: provisionVmJob.maxAttempts,
          delaySeconds: 0,
        },
      ]);
    });
  });
});

describe("failVmSetup", () => {
  test("fails the VM and retries it automatically, waiting longer each time, a limited number of times", async () => {
    await inRollback(db, async (tx) => {
      const { userId, vmId } = await provisioningVm(tx);
      const delays: number[] = [];
      for (let i = 1; i <= provisionVmJob.autoRetries; i++) {
        expect(await failVmSetup(tx, vmId)).toEqual({
          failures: i,
          retrying: true,
        });
        const [job] = await jobsOf(tx, userId).then((all) =>
          all.filter((j) => j.status === "queued"),
        );
        delays.push(job?.delaySeconds ?? -1);
        await takeJobs(tx, userId);
        await applyVmEvent(tx, vmId, "retry");
      }
      expect(delays).toEqual([30, 60, 90]);

      expect(await failVmSetup(tx, vmId)).toEqual({
        failures: provisionVmJob.autoRetries + 1,
        retrying: false,
      });
      expect(
        (await jobsOf(tx, userId)).filter((j) => j.status === "queued"),
      ).toEqual([]);
      expect((await vmOf(tx, userId)).state).toBe("failed");
    });
  });

  test("the count starts over once the VM is ready", async () => {
    await inRollback(db, async (tx) => {
      const { userId, vmId } = await provisioningVm(tx);
      await failVmSetup(tx, vmId);
      await applyVmEvent(tx, vmId, "retry");
      await applyVmEvent(tx, vmId, "provisioned");
      await applyVmEvent(tx, vmId, "registered");
      expect((await vmOf(tx, userId)).setupFailures).toBe(0);
    });
  });

  test("refuses a VM that isn't setting up, changing nothing", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      await requestVm(tx, user.id);
      const vm = await vmOf(tx, user.id);
      const error = await failVmSetup(tx, vm.id).catch((e: unknown) => e);
      expect(String(error)).toContain("Illegal VM transition");
      expect((await vmOf(tx, user.id)).setupFailures).toBe(0);
    });
  });
});

describe("retryFailedVm and computerStatus", () => {
  test("follow a computer from request to ready, through a failure the user retries", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      expect(await computerStatus(tx, user.id)).toBeNull();
      await requestVm(tx, user.id);
      expect(await computerStatus(tx, user.id)).toBe("setting_up");
      expect(await retryFailedVm(tx, user.id)).toBe(false);

      await takeJobs(tx, user.id);
      const vm = await vmOf(tx, user.id);
      await applyVmEvent(tx, vm.id, "provision");
      await tx
        .update(vms)
        .set({ setupFailures: provisionVmJob.autoRetries })
        .where(eq(vms.id, vm.id));
      await failVmSetup(tx, vm.id);
      expect(await computerStatus(tx, user.id)).toBe("failed");

      expect(await retryFailedVm(tx, user.id)).toBe(true);
      expect(await computerStatus(tx, user.id)).toBe("setting_up");

      await takeJobs(tx, user.id);
      await applyVmEvent(tx, vm.id, "retry");
      await applyVmEvent(tx, vm.id, "provisioned");
      await applyVmEvent(tx, vm.id, "registered");
      expect(await computerStatus(tx, user.id)).toBe("ready");
      await applyVmEvent(tx, vm.id, "missed_pings");
      expect(await computerStatus(tx, user.id)).toBe("unreachable");
    });
  });

  test("a failed computer with an automatic retry on the way is still setting up", async () => {
    await inRollback(db, async (tx) => {
      const { userId, vmId } = await provisioningVm(tx);
      await failVmSetup(tx, vmId);
      expect(await computerStatus(tx, userId)).toBe("setting_up");
    });
  });
});
