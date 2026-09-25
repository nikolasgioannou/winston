import assert from "node:assert/strict";
import { test } from "bun:test";
import { DeviceReservationError } from "@winston/adapters/database";
import type { DeviceExecution } from "@winston/contracts/device-executions";
import type { DeviceMessage } from "@winston/contracts/devices";
import { createDeviceDispatcher, type DeviceDispatchScope } from "../src/devices/dispatch";

test("device dispatch sends only a fresh committed reservation on the exact owning session", async () => {
  for (const prepared of [false, true])
    for (const mode of [
      "sent",
      "existing",
      "busy",
      "denied",
      "missing-channel",
      "closed-channel",
      "foreign-server",
      "wrong-session",
      "wrong-generation",
      "missing-route",
      "commit-failure",
      "disconnect-after-commit",
      "backpressure",
      "dropped",
      "send-error",
    ]) {
      const ownerId = crypto.randomUUID();
      const serverId = crypto.randomUUID();
      const session = {
        deviceId: crypto.randomUUID(),
        sessionId: crypto.randomUUID(),
        generation: 1,
      };
      const task = { id: crypto.randomUUID(), revision: 1, generation: 1 };
      const message: DeviceMessage = {
        version: 1,
        ...session,
        messageId: crypto.randomUUID(),
        correlationId: crypto.randomUUID(),
        payload: {
          kind: "execute",
          executionId: crypto.randomUUID(),
          taskId: task.id,
          taskRevision: task.revision,
          deadline: Date.now() + 60_000,
          operation: { kind: "command", executable: "/bin/true", arguments: [], directory: "/tmp" },
        },
      };
      const id = crypto.randomUUID();
      const proof: Parameters<ReturnType<typeof createDeviceDispatcher>>[1] = prepared
        ? { id, hash: "a".repeat(64), task, message }
        : { id, token: "test-proof", task, message };
      const execution: DeviceExecution = {
        actionId: proof.id,
        task,
        message,
        state: "dispatching",
        receipt: null,
        reconciliation: null,
      };
      let committed = false;
      let reservations = 0;
      let sends = 0;
      let closes = 0;
      let transactions = 0;
      const reserve = (
        received: typeof proof,
      ): ReturnType<DeviceDispatchScope["deviceExecutions"]["reserve"]> => {
        assert.deepEqual(received, proof);
        reservations += 1;
        if (prepared && (mode === "busy" || mode === "denied"))
          throw new DeviceReservationError(mode);
        if (mode === "busy" || mode === "denied") return Promise.resolve({ status: mode });
        return Promise.resolve({
          status: mode === "existing" ? "existing" : "reserved",
          execution,
        });
      };
      const dispatch = createDeviceDispatcher(
        {
          async transaction<Result>(
            owner: string,
            work: (scope: DeviceDispatchScope) => Promise<Result>,
          ) {
            assert.equal(owner, ownerId);
            transactions += 1;
            const result = await work({
              deviceSessions: {
                route: (deviceId) => {
                  assert.equal(deviceId, session.deviceId);
                  return Promise.resolve(
                    mode === "missing-route"
                      ? null
                      : {
                          ...session,
                          sessionId:
                            mode === "wrong-session" ? crypto.randomUUID() : session.sessionId,
                          generation: mode === "wrong-generation" ? 2 : 1,
                          server: {
                            serverId: mode === "foreign-server" ? crypto.randomUUID() : serverId,
                            machineId: null,
                          },
                        },
                  );
                },
              },
              deviceExecutions: {
                reserveApproved: (received) => {
                  assert.equal(prepared, true);
                  return reserve(received);
                },
                reserve: (received) => {
                  assert.equal(prepared, false);
                  return reserve(received);
                },
              },
            });
            if (mode === "commit-failure") throw new Error("Commit outcome unavailable");
            committed = true;
            return result;
          },
        },
        {
          serverId,
          channel(owner, identity) {
            assert.equal(owner, ownerId);
            assert.deepEqual(identity, session);
            if (mode === "missing-channel") return null;
            return {
              isOpen: () =>
                mode !== "closed-channel" && !(mode === "disconnect-after-commit" && committed),
              send(frame) {
                assert.equal(committed, true, "A frame escaped before commit");
                assert.deepEqual(JSON.parse(frame), message);
                sends += 1;
                if (mode === "send-error") throw new Error("Socket failed after accepting data");
                return mode === "backpressure" ? -1 : mode === "dropped" ? 0 : 1;
              },
              close() {
                closes += 1;
              },
            };
          },
        },
      );
      if (mode === "commit-failure") {
        await assert.rejects(() => dispatch(ownerId, proof), /Commit outcome unavailable/);
        assert.equal(sends, 0);
        assert.equal(closes, 0);
        continue;
      }
      const result = await dispatch(ownerId, proof);
      const unavailable = [
        "missing-channel",
        "closed-channel",
        "foreign-server",
        "wrong-session",
        "wrong-generation",
        "missing-route",
      ].includes(mode);
      const uncertain = [
        "disconnect-after-commit",
        "backpressure",
        "dropped",
        "send-error",
      ].includes(mode);
      assert.equal(result.status, unavailable ? "unavailable" : uncertain ? "uncertain" : mode);
      assert.equal(reservations, unavailable ? 0 : 1, mode);
      assert.equal(sends, ["sent", "backpressure", "dropped", "send-error"].includes(mode) ? 1 : 0);
      assert.equal(closes, uncertain ? 1 : 0);
      if (mode === "missing-channel" || mode === "closed-channel") assert.equal(transactions, 0);
    }
});
