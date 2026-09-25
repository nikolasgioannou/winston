import assert from "node:assert/strict";
import { test } from "bun:test";
import { cliResultSchema } from "@winston/contracts/cli";
import type { ServiceRequest } from "@winston/contracts/capabilities";
import { createDeviceRequestRouting, type DeviceRoutingScope } from "../src/devices/routing";

test("device routing authenticates twice and bounds Fly replay before execution", async () => {
  for (const mode of [
    "local",
    "arrived",
    "replay",
    "invalid-token",
    "stale-auth",
    "read-only",
    "missing-route",
    "wrong-device",
    "same-machine",
    "no-machine",
    "local-environment",
    "already-replayed",
    "fallback",
    "invalid-machine",
  ]) {
    const ownerId = crypto.randomUUID();
    const deviceId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const server = {
      serverId: crypto.randomUUID(),
      machineId: mode === "local-environment" ? null : "aabbccddeeff00",
    };
    const credential: ServiceRequest = {
      token: `wst_${"a".repeat(43)}`,
      kind: "workspace",
      subjectId: workspaceId,
      resourceId: workspaceId,
      operation: mode === "read-only" ? "gateway:read" : "gateway:control",
    };
    const authority = {
      kind: "workspace" as const,
      subjectId: workspaceId,
      resourceId: workspaceId,
      operation: "gateway:control" as const,
      taskId: crypto.randomUUID(),
      revision: 2,
      generation: 3,
      credential: null,
      resourceRevision: 0,
      ownerId,
      capabilityId: crypto.randomUUID(),
    };
    const session = {
      deviceId: mode === "wrong-device" ? crypto.randomUUID() : deviceId,
      sessionId: crypto.randomUUID(),
      generation: 4,
    };
    let authentications = 0;
    let lookups = 0;
    const route = createDeviceRequestRouting(
      {
        authenticateService: (input) => {
          assert.deepEqual(input, credential);
          authentications += 1;
          return Promise.resolve(mode === "invalid-token" ? null : authority);
        },
        transaction: <Result>(
          owner: string,
          work: (scope: DeviceRoutingScope) => Promise<Result>,
        ) => {
          assert.equal(owner, ownerId);
          return work({
            capabilities: {
              authenticate: (input) => {
                assert.deepEqual(input, credential);
                authentications += 1;
                return Promise.resolve(mode === "stale-auth" ? null : authority);
              },
            },
            deviceSessions: {
              route: (id) => {
                assert.equal(id, deviceId);
                lookups += 1;
                return Promise.resolve(
                  mode === "missing-route"
                    ? null
                    : {
                        ...session,
                        server: {
                          serverId: ["local", "arrived", "fallback"].includes(mode)
                            ? server.serverId
                            : crypto.randomUUID(),
                          machineId:
                            mode === "invalid-machine"
                              ? "evil;app=other"
                              : mode === "no-machine"
                                ? null
                                : mode === "same-machine"
                                  ? server.machineId
                                  : "11223344556677",
                        },
                      },
                );
              },
            },
          });
        },
      },
      server,
    );
    const headers = new Headers();
    if (["already-replayed", "arrived"].includes(mode))
      headers.set("fly-replay-src", "previous-instance");
    if (mode === "fallback") headers.set("fly-replay-failed", "unreachable");
    if (mode === "invalid-machine") {
      await assert.rejects(() => route(credential, deviceId, headers));
      continue;
    }
    const result = await route(credential, deviceId, headers);
    assert.equal(authentications, mode === "read-only" ? 0 : mode === "invalid-token" ? 1 : 2);
    assert.equal(lookups, ["read-only", "invalid-token", "stale-auth"].includes(mode) ? 0 : 1);
    if (mode === "local" || mode === "arrived") {
      assert.equal(result.kind, "local");
      assert.deepEqual(result.session, session);
      assert.equal(result.ownerId, ownerId);
      assert.deepEqual(result.task, { id: authority.taskId, revision: 2, generation: 3 });
      continue;
    }
    assert.equal(result.kind, "response");
    const response = result.response;
    assert.equal(
      response.headers.get("fly-replay"),
      mode === "replay" ? "instance=11223344556677;timeout=2s;fallback=force_self" : null,
    );
    assert.equal(response.headers.has("fly-replay-cache"), false);
    const body = cliResultSchema.parse(await response.json());
    assert.equal(
      body.status,
      ["read-only", "invalid-token", "stale-auth"].includes(mode) ? "denied" : "unavailable",
    );
    assert.ok(!JSON.stringify(body).includes(credential.token));
    assert.ok(!JSON.stringify(body).includes(authority.taskId));
  }
});
