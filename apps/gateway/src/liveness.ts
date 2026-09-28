import type { DbOrTx } from "@winston/db/client";
import { vms } from "@winston/db/schema";
import { applyVmEvent, type VmEvent } from "@winston/db/vm-state";
import type { Logger } from "@winston/shared/logger";
import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";

export interface LivenessLimits {
  /** A ready VM with no ping for this long is unhealthy (docs/design.md §17). */
  pingTimeoutMs: number;
  /** A VM stuck provisioning or registering this long has failed. */
  setupTimeoutMs: number;
}

export const defaultLivenessLimits: LivenessLimits = {
  pingTimeoutMs: 2 * 60_000,
  setupTimeoutMs: 10 * 60_000,
};

const olderThan = (
  column: typeof vms.lastSeenAt | typeof vms.stateChangedAt,
  ms: number,
) => lt(column, sql`now() - ${ms} * interval '1 millisecond'`);

/**
 * Moves VMs whose time ran out: ready ones that stopped pinging become
 * `unhealthy`, and ones stuck in setup become `failed`. Each move goes
 * through the state machine, so a VM that changed meanwhile is left alone.
 */
export async function sweepVms(
  db: DbOrTx,
  logger: Logger,
  limits = defaultLivenessLimits,
) {
  const silent = await db
    .select({ id: vms.id })
    .from(vms)
    .where(
      and(
        eq(vms.state, "ready"),
        or(
          olderThan(vms.lastSeenAt, limits.pingTimeoutMs),
          and(
            isNull(vms.lastSeenAt),
            olderThan(vms.stateChangedAt, limits.pingTimeoutMs),
          ),
        ),
      ),
    );
  const stuck = await db
    .select({ id: vms.id })
    .from(vms)
    .where(
      and(
        inArray(vms.state, ["provisioning", "registering"]),
        olderThan(vms.stateChangedAt, limits.setupTimeoutMs),
      ),
    );

  const apply = async (vmId: string, event: VmEvent) => {
    try {
      const state = await applyVmEvent(db, vmId, event);
      logger.warn({ vmId, event, state }, "VM timed out");
    } catch (error) {
      logger.debug(
        { err: error, vmId, event },
        "VM changed before the sweep reached it",
      );
    }
  };
  for (const vm of silent) await apply(vm.id, "missed_pings");
  for (const vm of stuck) await apply(vm.id, "timed_out");
}
