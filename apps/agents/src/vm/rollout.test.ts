import { describe, expect, test } from "bun:test";
import type { DbOrTx } from "@winston/db/client";
import { createHandoff } from "@winston/db/handoffs";
import { handoffs, runs, vms } from "@winston/db/schema";
import { inRollback, insertRun, insertUser, testDb } from "@winston/db/testing";
import { createVm } from "@winston/db/vms";
import { createLogger } from "@winston/shared/logger";
import { eq, sql } from "drizzle-orm";
import type { VmProvider } from "./provider.ts";
import { inHours, parseHours, rollVmHandler, vmsToRoll } from "./rollout.ts";

const db = await testDb();
const logger = createLogger("agents-test", {
  pretty: false,
  destination: { write: () => undefined },
});
const quiet = parseHours("3-5");
// 3:30 am in New York.
const nightInNewYork = new Date("2026-10-05T07:30:00Z");

async function readyVm(
  tx: DbOrTx,
  imageId: string | null,
  timezone = "America/New_York",
) {
  const user = await insertUser(tx, { timezone });
  const vm = await createVm(tx, user.id, "docker");
  await tx
    .update(vms)
    .set({
      state: "ready",
      instanceId: "inst-old",
      dataVolumeId: "vol-1",
      imageId,
    })
    .where(eq(vms.id, vm.id));
  return user.id;
}

describe("image rollouts", () => {
  test("quiet hours are the user's own, and may wrap midnight", () => {
    expect(inHours(quiet, "America/New_York", nightInNewYork)).toBe(true);
    expect(inHours(quiet, "Europe/London", nightInNewYork)).toBe(false);
    expect(
      inHours(parseHours("23-2"), "UTC", new Date("2026-10-05T00:30:00Z")),
    ).toBe(true);
    expect(inHours(parseHours("0-24"), "UTC", nightInNewYork)).toBe(true);
  });

  test("a ready VM on another image, or none recorded, moves in its quiet hours unless something's going on", async () => {
    await inRollback(db, async (tx) => {
      const old = await readyVm(tx, "ami-old");
      const unknown = await readyVm(tx, null);
      await readyVm(tx, "ami-new");
      const awake = await readyVm(tx, "ami-old", "Europe/London");
      const working = await readyVm(tx, "ami-old");
      await insertRun(tx, working, { kind: "background", status: "running" });
      const handingOver = await readyVm(tx, "ami-old");
      const task = await insertRun(tx, handingOver, {
        kind: "background",
        status: "parked",
      });
      await createHandoff(tx, {
        runId: task.id,
        userId: handingOver,
        windowId: "win_1",
        targetId: "T1",
        reason: "Sign in",
      });
      // A handoff left open for days doesn't hold a VM back for ever.
      const forgotten = await readyVm(tx, "ami-old");
      const oldTask = await insertRun(tx, forgotten, {
        kind: "background",
        status: "parked",
      });
      const stale = await createHandoff(tx, {
        runId: oldTask.id,
        userId: forgotten,
        windowId: "win_1",
        targetId: "T1",
        reason: "x",
      });
      await tx
        .update(handoffs)
        .set({ createdAt: sql`now() - interval '2 days'`, status: "connected" })
        .where(eq(handoffs.id, stale.id));

      const due = await vmsToRoll(tx, "ami-new", quiet, nightInNewYork);
      expect(due.sort()).toEqual([old, unknown, forgotten].sort());
      expect(due).not.toContain(awake);
    });
  });

  test("rolling replaces the instance on the same data volume and records the new image", async () => {
    await inRollback(db, async (tx) => {
      const userId = await readyVm(tx, "ami-old", "UTC");
      const destroyed: string[] = [];
      const created: (string | undefined)[] = [];
      const provider = {
        kind: "docker",
        currentImage: () => Promise.resolve("ami-new"),
        create: ({ dataVolumeId }: { dataVolumeId?: string | undefined }) => {
          created.push(dataVolumeId);
          return Promise.resolve({
            instanceId: "inst-new",
            dataVolumeId: dataVolumeId ?? "",
            imageId: "ami-new",
          });
        },
        start: () => Promise.resolve(),
        destroy: (instanceId: string) => {
          destroyed.push(instanceId);
          return Promise.resolve();
        },
      } as unknown as VmProvider;
      await rollVmHandler(
        provider,
        parseHours("0-24"),
      )({
        job: { userId } as never,
        db: tx as never,
        logger,
        extendLease: () => Promise.resolve(true),
      });
      expect(destroyed).toEqual(["inst-old"]);
      expect(created).toEqual(["vol-1"]);
      const [vm] = await tx.select().from(vms).where(eq(vms.userId, userId));
      expect(vm).toMatchObject({
        state: "registering",
        instanceId: "inst-new",
        imageId: "ami-new",
      });
    });
  });

  test("a forced roll moves it outside the quiet hours, but still not while it's busy", async () => {
    await inRollback(db, async (tx) => {
      const userId = await readyVm(tx, "ami-old", "UTC");
      const replaced: string[] = [];
      const provider = {
        kind: "docker",
        currentImage: () => Promise.resolve("ami-new"),
        create: () =>
          Promise.resolve({
            instanceId: "inst-new",
            dataVolumeId: "vol-1",
            imageId: "ami-new",
          }),
        start: () => Promise.resolve(),
        destroy: (instanceId: string) => {
          replaced.push(instanceId);
          return Promise.resolve();
        },
      } as unknown as VmProvider;
      // Hours that never come.
      const never = { from: 0, to: 0 };
      const roll = (now: boolean) =>
        rollVmHandler(
          provider,
          never,
        )({
          job: { userId, payload: now ? { now: true } : {} } as never,
          db: tx as never,
          logger,
          extendLease: () => Promise.resolve(true),
        });
      await insertRun(tx, userId, { kind: "background", status: "running" });
      await roll(true);
      expect(replaced).toEqual([]);
      await tx
        .update(runs)
        .set({ status: "completed" })
        .where(eq(runs.userId, userId));
      await roll(false);
      expect(replaced).toEqual([]);
      await roll(true);
      expect(replaced).toEqual(["inst-old"]);
    });
  });
});
