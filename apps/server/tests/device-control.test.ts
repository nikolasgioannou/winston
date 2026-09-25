import assert from "node:assert/strict";
import { test } from "bun:test";
import type { DeviceMessage } from "@winston/contracts/devices";
import { createDeviceControlDelivery, type DeviceControlScope } from "../src/devices/control";

test("device control delivery commits queries before sending and rejects unsafe plans", async () => {
  for (const mode of [
    "sent",
    "closed",
    "foreign-server",
    "wrong-session",
    "missing-route",
    "commit-failure",
    "disconnect-after-commit",
    "backpressure",
    "dropped",
    "send-error",
    "execute",
    "wrong-binding",
    "oversized",
  ]) {
    const ownerId = crypto.randomUUID();
    const serverId = crypto.randomUUID();
    const session = {
      deviceId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      generation: 1,
    };
    const message: DeviceMessage = {
      version: 1,
      ...session,
      messageId: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      payload: {
        kind: "cancel",
        executionId: crypto.randomUUID(),
        taskId: crypto.randomUUID(),
        taskRevision: 1,
      },
    };
    let committed = false;
    let planned = 0;
    let sends = 0;
    let closes = 0;
    const deliver = createDeviceControlDelivery(
      {
        async transaction<Result>(
          owner: string,
          work: (scope: DeviceControlScope) => Promise<Result>,
        ) {
          assert.equal(owner, ownerId);
          const result = await work({
            deviceSessions: {
              route: () =>
                Promise.resolve(
                  mode === "missing-route"
                    ? null
                    : {
                        ...session,
                        sessionId:
                          mode === "wrong-session" ? crypto.randomUUID() : session.sessionId,
                        server: {
                          serverId: mode === "foreign-server" ? crypto.randomUUID() : serverId,
                          machineId: null,
                        },
                      },
                ),
            },
            deviceExecutions: {
              planControls: (identity) => {
                assert.deepEqual(identity, session);
                planned += 1;
                assert.equal(message.payload.kind, "cancel");
                const changed: DeviceMessage =
                  mode === "execute"
                    ? {
                        ...message,
                        payload: {
                          ...message.payload,
                          kind: "execute",
                          deadline: Date.now() + 60_000,
                          operation: {
                            kind: "command",
                            executable: "/bin/true",
                            arguments: [],
                            directory: "/tmp",
                          },
                        },
                      }
                    : mode === "wrong-binding"
                      ? { ...message, generation: 2 }
                      : message;
                return Promise.resolve(
                  Array.from({ length: mode === "oversized" ? 7 : 2 }, () => changed),
                );
              },
            },
          });
          if (mode === "commit-failure") throw new Error("Commit failed");
          committed = true;
          return result;
        },
      },
      serverId,
    );
    const run = () =>
      deliver(ownerId, session, {
        isOpen: () => mode !== "closed" && !(mode === "disconnect-after-commit" && committed),
        send(frame) {
          assert.equal(committed, true);
          assert.deepEqual(JSON.parse(frame), message);
          sends += 1;
          if (mode === "send-error") throw new Error("Send failed");
          return mode === "backpressure" ? -1 : mode === "dropped" ? 0 : 1;
        },
        close() {
          closes += 1;
        },
      });
    if (["commit-failure", "execute", "wrong-binding", "oversized"].includes(mode)) {
      await assert.rejects(run);
      assert.equal(sends, 0);
      assert.equal(committed, false);
      continue;
    }
    await run();
    const failedSend = ["backpressure", "dropped", "send-error"].includes(mode);
    assert.equal(sends, mode === "sent" ? 2 : failedSend ? 1 : 0, mode);
    assert.equal(closes, failedSend ? 1 : 0, mode);
    assert.equal(
      planned,
      ["closed", "foreign-server", "wrong-session", "missing-route"].includes(mode) ? 0 : 1,
      mode,
    );
  }
});
