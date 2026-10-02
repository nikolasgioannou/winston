/**
 * The VM cost job (docs/design.md §8, Cost tracking): every hour, each EC2
 * VM with an instance is charged for the time since its last charge, so a
 * user's spend includes their computer. Local Docker VMs cost nothing.
 */
import type { Db, DbOrTx } from "@winston/db/client";
import { costLedger, vms } from "@winston/db/schema";
import type { Logger } from "@winston/shared/logger";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { vmCostPerHour } from "../model/pricing.ts";

/** States in which an instance exists and is billed. */
const billed = [
  "provisioning",
  "registering",
  "ready",
  "unhealthy",
  "updating",
  "terminating",
] as const;

export const vmCostEveryMs = 60 * 60_000;

/** Charges every billed VM up to `now`. Returns how many were charged. */
export async function accrueVmCosts(db: DbOrTx, now = new Date()) {
  const due = await db
    .select({ id: vms.id })
    .from(vms)
    .where(
      and(
        eq(vms.provider, "ec2"),
        isNotNull(vms.instanceId),
        inArray(vms.state, [...billed]),
      ),
    );
  let charged = 0;
  for (const { id } of due)
    await db.transaction(async (tx) => {
      // Locked, so two agents tasks (a deploy) never charge the same hour twice.
      const [vm] = await tx
        .select()
        .from(vms)
        .where(eq(vms.id, id))
        .for("update");
      if (!vm) return;
      // The first charge starts when it reached its current state.
      const from = vm.costAccruedAt ?? vm.stateChangedAt;
      const hours = (now.getTime() - from.getTime()) / 3_600_000;
      if (hours <= 0) return;
      await tx.insert(costLedger).values({
        userId: vm.userId,
        category: "vm",
        costUsd: (hours * vmCostPerHour).toFixed(6),
        occurredAt: now,
      });
      await tx
        .update(vms)
        .set({ costAccruedAt: sql`${now.toISOString()}::timestamptz` })
        .where(eq(vms.id, id));
      charged += 1;
    });
  return charged;
}

export function startVmCostJob(db: Db, logger: Logger) {
  const sweep = () => {
    accrueVmCosts(db).catch((error: unknown) => {
      logger.error({ err: error }, "accruing VM costs failed");
    });
  };
  const timer = setInterval(sweep, vmCostEveryMs);
  sweep();
  return () => {
    clearInterval(timer);
  };
}
