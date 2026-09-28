/**
 * The VM state machine (docs/design.md §17), in one place for every service
 * that changes a VM's state.
 */
import { eq, sql } from "drizzle-orm";
import type { DbOrTx } from "./client.ts";
import { vms, type vmState } from "./schema/index.ts";

export type VmState = (typeof vmState.enumValues)[number];

export type VmEvent =
  | "provision"
  | "provisioned"
  | "registered"
  | "missed_pings"
  | "recovered"
  | "update_started"
  | "update_finished"
  | "timed_out"
  | "retry"
  | "replace"
  | "terminate"
  | "terminated";

/** From each state, the events it accepts and where they lead. */
const transitions: Record<VmState, Partial<Record<VmEvent, VmState>>> = {
  requested: { provision: "provisioning", terminate: "terminating" },
  provisioning: {
    provisioned: "registering",
    timed_out: "failed",
    terminate: "terminating",
  },
  registering: {
    registered: "ready",
    timed_out: "failed",
    terminate: "terminating",
  },
  ready: {
    missed_pings: "unhealthy",
    update_started: "updating",
    replace: "provisioning",
    terminate: "terminating",
  },
  unhealthy: {
    recovered: "ready",
    replace: "provisioning",
    terminate: "terminating",
  },
  updating: { update_finished: "ready", terminate: "terminating" },
  failed: {
    retry: "provisioning",
    replace: "provisioning",
    terminate: "terminating",
  },
  terminating: { terminated: "terminated" },
  terminated: {},
};

/** The state `event` leads to from `state`. Throws on an illegal move. */
export function transition(state: VmState, event: VmEvent): VmState {
  const next = transitions[state][event];
  if (!next) throw new Error(`Illegal VM transition: ${event} from ${state}`);
  return next;
}

/**
 * Applies `event` to a VM with its row locked, so concurrent services can't
 * race each other. Returns the new state. Throws on an illegal move.
 */
export async function applyVmEvent(db: DbOrTx, vmId: string, event: VmEvent) {
  return db.transaction(async (tx) => {
    const [vm] = await tx
      .select({ state: vms.state })
      .from(vms)
      .where(eq(vms.id, vmId))
      .for("update");
    if (!vm) throw new Error(`No VM ${vmId}`);
    const next = transition(vm.state, event);
    await tx
      .update(vms)
      .set({ state: next, stateChangedAt: sql`now()` })
      .where(eq(vms.id, vmId));
    return next;
  });
}
