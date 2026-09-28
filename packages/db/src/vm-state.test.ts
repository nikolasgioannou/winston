import { describe, expect, test } from "bun:test";
import { vms, vmState } from "./schema/index.ts";
import { eq } from "drizzle-orm";
import { inRollback, insertUser, testDb } from "./testing.ts";
import {
  applyVmEvent,
  transition,
  type VmEvent,
  type VmState,
} from "./vm-state.ts";
import { tokenMatches } from "@winston/shared/tokens";
import { createVm, issueRegistrationToken } from "./vms.ts";

const db = await testDb();

const events: VmEvent[] = [
  "provision",
  "provisioned",
  "registered",
  "missed_pings",
  "recovered",
  "update_started",
  "update_finished",
  "timed_out",
  "retry",
  "replace",
  "terminate",
  "terminated",
];

/** The legal moves, written out from docs/design.md §17 independently of the implementation. */
const legal: [VmState, VmEvent, VmState][] = [
  ["requested", "provision", "provisioning"],
  ["provisioning", "provisioned", "registering"],
  ["registering", "registered", "ready"],
  ["ready", "missed_pings", "unhealthy"],
  ["unhealthy", "recovered", "ready"],
  ["ready", "update_started", "updating"],
  ["updating", "update_finished", "ready"],
  ["provisioning", "timed_out", "failed"],
  ["registering", "timed_out", "failed"],
  ["failed", "retry", "provisioning"],
  // A new instance on the same data volume: image upgrades, a vanished container, AMI moves.
  ["ready", "replace", "provisioning"],
  ["unhealthy", "replace", "provisioning"],
  ["failed", "replace", "provisioning"],
  ...(
    [
      "requested",
      "provisioning",
      "registering",
      "ready",
      "unhealthy",
      "updating",
      "failed",
    ] as const
  ).map((state): [VmState, VmEvent, VmState] => [
    state,
    "terminate",
    "terminating",
  ]),
  ["terminating", "terminated", "terminated"],
];

describe("transition", () => {
  test("every legal move leads where §17 says", () => {
    for (const [from, event, to] of legal)
      expect(transition(from, event)).toBe(to);
  });

  test("every other state and event pair throws", () => {
    for (const state of vmState.enumValues)
      for (const event of events) {
        if (legal.some(([from, e]) => from === state && e === event)) continue;
        expect(() => transition(state, event)).toThrow(
          `Illegal VM transition: ${event} from ${state}`,
        );
      }
  });

  test("terminated is final", () => {
    for (const event of events)
      expect(() => transition("terminated", event)).toThrow();
  });
});

describe("VMs in the database", () => {
  test("registration tokens are stored only hashed, and a new one replaces the old", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const vm = await createVm(tx, user.id, "docker");
      expect(vm.state).toBe("requested");
      expect(vm.id.startsWith("vm_")).toBe(true);
      const token = await issueRegistrationToken(tx, vm.id);
      const [row] = await tx.select().from(vms).where(eq(vms.id, vm.id));
      expect(JSON.stringify(row)).not.toContain(token);
      expect(tokenMatches(token, row?.registrationTokenHash ?? "")).toBe(true);

      const replacement = await issueRegistrationToken(tx, vm.id);
      const [after] = await tx.select().from(vms).where(eq(vms.id, vm.id));
      expect(tokenMatches(token, after?.registrationTokenHash ?? "")).toBe(
        false,
      );
      expect(
        tokenMatches(replacement, after?.registrationTokenHash ?? ""),
      ).toBe(true);
    });
  });

  test("applyVmEvent moves the stored state and refuses illegal moves", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const vm = await createVm(tx, user.id, "docker");
      expect(await applyVmEvent(tx, vm.id, "provision")).toBe("provisioning");
      const error = await applyVmEvent(tx, vm.id, "registered").catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(Error);
      const [row] = await tx.select().from(vms).where(eq(vms.id, vm.id));
      expect(row?.state).toBe("provisioning");
    });
  });

  test("one VM per user", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      await createVm(tx, user.id, "docker");
      const error = await createVm(tx, user.id, "docker").catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(Error);
    });
  });
});
