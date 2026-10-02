import { describe, expect, test } from "bun:test";
import { costLedger, vms } from "@winston/db/schema";
import { inRollback, insertUser, testDb } from "@winston/db/testing";
import { eq } from "drizzle-orm";
import { vmCostPerHour } from "../model/pricing.ts";
import { accrueVmCosts } from "./costs.ts";

const db = await testDb();

describe("VM costs", () => {
  test("a running EC2 VM is charged for each stretch since its last charge, across hour boundaries; others aren't", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const started = new Date("2026-10-05T12:30:00Z");
      const [vm] = await tx
        .insert(vms)
        .values({
          userId: user.id,
          provider: "ec2",
          instanceId: "i-123",
          state: "ready",
          stateChangedAt: started,
        })
        .returning();
      // A local VM and a terminated one cost nothing.
      const local = await insertUser(tx);
      await tx.insert(vms).values({
        userId: local.id,
        provider: "docker",
        instanceId: "c-1",
        state: "ready",
        stateChangedAt: started,
      });
      const gone = await insertUser(tx);
      await tx.insert(vms).values({
        userId: gone.id,
        provider: "ec2",
        instanceId: "i-9",
        state: "terminated",
        stateChangedAt: started,
      });

      const at = (iso: string) => new Date(iso);
      expect(await accrueVmCosts(tx, at("2026-10-05T13:00:00Z"))).toBe(1);
      expect(await accrueVmCosts(tx, at("2026-10-05T14:00:00Z"))).toBe(1);
      // Run twice for the same moment (two agents tasks): nothing more.
      expect(await accrueVmCosts(tx, at("2026-10-05T14:00:00Z"))).toBe(0);

      const charges = await tx.select().from(costLedger);
      expect(
        charges.every((c) => c.userId === user.id && c.category === "vm"),
      ).toBe(true);
      expect(charges.map((c) => Number(c.costUsd))).toEqual([
        Number((0.5 * vmCostPerHour).toFixed(6)),
        Number((1 * vmCostPerHour).toFixed(6)),
      ]);
      const [after] = await tx
        .select()
        .from(vms)
        .where(eq(vms.id, vm?.id ?? ""));
      expect(after?.costAccruedAt?.toISOString()).toBe(
        "2026-10-05T14:00:00.000Z",
      );
    });
  });
});
