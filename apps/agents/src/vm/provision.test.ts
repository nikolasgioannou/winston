import { describe, expect, test } from "bun:test";
import type { DbOrTx } from "@winston/db/client";
import type { Job } from "@winston/db/queue";
import { jobs, vms } from "@winston/db/schema";
import { inRollback, insertUser, testDb } from "@winston/db/testing";
import { applyVmEvent } from "@winston/db/vm-state";
import { createVm, requestVm } from "@winston/db/vms";
import { createLogger } from "@winston/shared/logger";
import { tokenMatches } from "@winston/shared/tokens";
import { eq } from "drizzle-orm";
import type { VmProvider } from "./provider.ts";
import { provisionVm, provisionVmHandler } from "./provision.ts";

const db = await testDb();
const logger = createLogger("agents-test", {
  pretty: false,
  destination: { write: () => undefined },
});

/** A provider that records what it was asked, optionally failing on create. */
function fakeProvider(options: { failCreate?: boolean } = {}) {
  const tokens: string[] = [];
  const started: string[] = [];
  const provider: VmProvider = {
    kind: "docker",
    create: ({ registrationToken }) => {
      if (options.failCreate)
        return Promise.reject(new Error("docker is down"));
      tokens.push(registrationToken);
      return Promise.resolve({
        instanceId: `inst-${String(tokens.length)}`,
        dataVolumeId: "vol-1",
      });
    },
    start: (instanceId) => {
      started.push(instanceId);
      return Promise.resolve();
    },
    stop: () => Promise.resolve(),
    destroy: () => Promise.resolve(),
    destroyDataVolume: () => Promise.resolve(),
    status: () => Promise.resolve("running"),
  };
  return { provider, tokens, started };
}

const vmOf = async (tx: DbOrTx, userId: string) =>
  (await tx.select().from(vms).where(eq(vms.userId, userId)))[0];

describe("provisionVm", () => {
  test("creates the VM, hands over a registration token stored only hashed, and waits in registering", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const { provider, tokens, started } = fakeProvider();
      await provisionVm({ db: tx, logger, provider }, user.id);
      const vm = await vmOf(tx, user.id);
      expect(vm).toMatchObject({
        state: "registering",
        provider: "docker",
        instanceId: "inst-1",
        dataVolumeId: "vol-1",
      });
      expect(started).toEqual(["inst-1"]);
      expect(
        tokenMatches(tokens[0] ?? "", vm?.registrationTokenHash ?? ""),
      ).toBe(true);
      expect(JSON.stringify(vm)).not.toContain(tokens[0] ?? "");
    });
  });

  test("a failed attempt can be retried, with a fresh token", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const failing = await provisionVm(
        {
          db: tx,
          logger,
          provider: fakeProvider({ failCreate: true }).provider,
        },
        user.id,
      ).catch((e: unknown) => e);
      expect(failing).toBeInstanceOf(Error);
      expect((await vmOf(tx, user.id))?.state).toBe("provisioning");

      // The job's retry resumes from provisioning.
      const { provider, tokens } = fakeProvider();
      await provisionVm({ db: tx, logger, provider }, user.id);
      const vm = await vmOf(tx, user.id);
      expect(vm?.state).toBe("registering");
      expect(
        tokenMatches(tokens[0] ?? "", vm?.registrationTokenHash ?? ""),
      ).toBe(true);
    });
  });

  test("a VM that timed out is retried from failed", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const vm = await createVm(tx, user.id, "docker");
      await applyVmEvent(tx, vm.id, "provision");
      await applyVmEvent(tx, vm.id, "setup_failed");
      await provisionVm(
        { db: tx, logger, provider: fakeProvider().provider },
        user.id,
      );
      expect((await vmOf(tx, user.id))?.state).toBe("registering");
    });
  });

  test("replace gives a ready VM a new instance on the same volume, and drops the old token", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const destroyed: string[] = [];
      const { provider, tokens, started } = fakeProvider();
      provider.destroy = (instanceId) => {
        destroyed.push(instanceId);
        return Promise.resolve();
      };
      await provisionVm({ db: tx, logger, provider }, user.id);
      const first = await vmOf(tx, user.id);
      await tx
        .update(vms)
        .set({ state: "ready", tokenHash: "old-token-hash" })
        .where(eq(vms.userId, user.id));

      await provisionVm({ db: tx, logger, provider }, user.id, {
        replace: true,
      });
      const vm = await vmOf(tx, user.id);
      expect(vm?.id).toBe(first?.id ?? "");
      expect(destroyed).toEqual(["inst-1"]);
      expect(started).toEqual(["inst-1", "inst-2"]);
      expect(vm).toMatchObject({
        state: "registering",
        instanceId: "inst-2",
        dataVolumeId: "vol-1",
        tokenHash: null,
      });
      expect(
        tokenMatches(tokens[1] ?? "", vm?.registrationTokenHash ?? ""),
      ).toBe(true);
    });
  });

  test("an already provisioned VM is left alone", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const { provider, started } = fakeProvider();
      await provisionVm({ db: tx, logger, provider }, user.id);
      await provisionVm({ db: tx, logger, provider }, user.id);
      expect(started).toHaveLength(1);
    });
  });
});

describe("provisionVmHandler", () => {
  const runJob = (
    tx: DbOrTx,
    provider: VmProvider,
    userId: string,
    attempt: { attempts: number; maxAttempts: number },
  ) =>
    provisionVmHandler(provider)({
      job: { id: "job_1", userId, payload: {}, ...attempt } as unknown as Job,
      db: tx as never,
      logger,
      extendLease: () => Promise.resolve(true),
    });

  test("provisions a requested VM, recording its provider", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      await requestVm(tx, user.id);
      await runJob(tx, fakeProvider().provider, user.id, {
        attempts: 1,
        maxAttempts: 3,
      });
      expect(await vmOf(tx, user.id)).toMatchObject({
        state: "registering",
        provider: "docker",
      });
    });
  });

  test("a failed attempt leaves the VM setting up for the job's next one; the last fails its setup and queues an automatic retry", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      await requestVm(tx, user.id);
      await tx.delete(jobs).where(eq(jobs.userId, user.id));
      const { provider } = fakeProvider({ failCreate: true });

      const early = await runJob(tx, provider, user.id, {
        attempts: 1,
        maxAttempts: 3,
      }).catch((e: unknown) => e);
      expect(early).toBeInstanceOf(Error);
      expect((await vmOf(tx, user.id))?.state).toBe("provisioning");

      const last = await runJob(tx, provider, user.id, {
        attempts: 3,
        maxAttempts: 3,
      }).catch((e: unknown) => e);
      expect(last).toBeInstanceOf(Error);
      expect(await vmOf(tx, user.id)).toMatchObject({
        state: "failed",
        setupFailures: 1,
      });
      expect(
        await tx
          .select({ type: jobs.type, status: jobs.status })
          .from(jobs)
          .where(eq(jobs.userId, user.id)),
      ).toEqual([{ type: "provision_vm", status: "queued" }]);
    });
  });
});
