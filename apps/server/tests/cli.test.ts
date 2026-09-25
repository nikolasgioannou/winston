import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import type { OwnerTransaction } from "@winston/adapters/database";
import type { ServiceRequest } from "@winston/contracts/capabilities";
import { createApi } from "../src/http/app";
import { createCliTaskGroup } from "../src/http/cli";

test("CLI endpoint rejects invalid authority and input before calling the scoped repository", async () => {
  const workspaceId = randomUUID();
  const ownerId = randomUUID();
  const token = `wst_${"a".repeat(43)}`;
  const controlToken = `wst_${"b".repeat(43)}`;
  let calls = 0;
  let cancellations = 0;
  let reads = 0;
  let fileCalls = 0;
  let scheduleCalls = 0;
  let responsibilityCalls = 0;
  let deviceCalls = 0;
  let calendarCalls = 0;
  const cli: OwnerTransaction["cli"] = {
    responsibility: (credential, input) => {
      assert.equal(
        credential.token,
        input.command === "responsibilities.propose" ? controlToken : token,
      );
      responsibilityCalls++;
      return Promise.resolve({ version: 1, status: "ok", data: {} });
    },
    schedule: (credential, input) => {
      assert.equal(credential.token, input.command === "schedules.cancel" ? controlToken : token);
      scheduleCalls++;
      return Promise.resolve({ version: 1, status: "ok", data: {} });
    },
    connect: () => Promise.resolve({ version: 1, status: "waiting", message: "Connect account." }),
    cancel: () => {
      cancellations += 1;
      return Promise.resolve({ version: 1, status: "waiting", message: "Cancellation requested." });
    },
    execute: () => {
      calls += 1;
      return Promise.resolve({ version: 1, status: "ok", data: [] });
    },
  };
  const database = {
    authenticateService: (input: ServiceRequest) =>
      Promise.resolve(
        ((input.token === token && input.operation === "gateway:read") ||
          (input.token === controlToken && input.operation === "gateway:control")) &&
          input.subjectId === workspaceId &&
          input.resourceId === workspaceId &&
          input.kind === "workspace"
          ? {
              ...input,
              ownerId,
              taskId: randomUUID(),
              revision: 1,
              generation: 1,
              credential: null,
              capabilityId: randomUUID(),
            }
          : null,
      ),
    transaction: <Result>(
      owner: string,
      work: (scope: Pick<OwnerTransaction, "cli">) => Promise<Result>,
    ) => {
      assert.equal(owner, ownerId);
      return work({ cli });
    },
  };
  const { app } = createApi({
    groups: {
      task: createCliTaskGroup(database, {
        calendarMutations: (credential, input, signal) => {
          assert.equal(credential.token, controlToken);
          assert.equal(input.intent.kind, "delete");
          assert.equal(input.key, "remove-event");
          assert.equal(signal.aborted, false);
          calendarCalls++;
          return Promise.resolve({ version: 1, status: "waiting", message: "Approval required." });
        },
        read: (credential, input) => {
          assert.equal(credential.token, "key" in input ? controlToken : token);
          assert.equal(input.command, "gmail.search");
          reads += 1;
          return Promise.resolve({ version: 1, status: "ok", data: [] });
        },
        files: (credential, request) => {
          assert.equal(credential.token, request.command === "files.send" ? controlToken : token);
          fileCalls++;
          return Promise.resolve({ version: 1, status: "ok", data: { state: "pending" } });
        },
        devices: (credential, input, headers, signal) => {
          assert.equal(
            credential.token,
            input.command === "devices.command" ? controlToken : token,
          );
          assert.equal(headers.get("X-Winston-Workspace"), workspaceId);
          assert.equal(signal.aborted, false);
          deviceCalls++;
          return Promise.resolve(
            Response.json(
              { version: 1, status: "unavailable", message: "Route to socket owner." },
              { headers: { "fly-replay": "instance=abcdef123456;timeout=2s;fallback=force_self" } },
            ),
          );
        },
      }),
    },
  });
  const request = (
    body: unknown,
    bearer = token,
    workspace = workspaceId,
    path = "/api/tasks/cli",
  ) =>
    app.request(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearer}`,
        "X-Winston-Workspace": workspace,
      },
      body: JSON.stringify(body),
    });
  assert.equal((await request({ version: 1, command: "accounts.list" })).status, 200);
  assert.equal((await request({ version: 1, command: "accounts.list" }, "bad")).status, 401);
  assert.equal(
    (await request({ version: 1, command: "accounts.list" }, token, randomUUID())).status,
    401,
  );
  assert.equal((await request({ version: 1, command: "accounts.list", ownerId })).status, 400);
  assert.equal((await request({ version: 1, command: "invented" })).status, 400);
  const cancellation = { version: 1, command: "operations.cancel", id: randomUUID() };
  const read = { version: 1, command: "gmail.search", accountId: randomUUID(), query: "fixture" };
  assert.equal((await request(read)).status, 200);
  assert.equal((await request(read, "bad")).status, 401);
  assert.equal(reads, 1);
  const controlPath = "/api/tasks/cli/control";
  const calendar = {
    version: 1,
    command: "calendar.delete",
    accountId: randomUUID(),
    calendarId: "primary",
    key: "remove-event",
    eventId: "event1",
    etag: '"version1"',
    scope: { kind: "single" },
    sendUpdates: "none",
  };
  assert.equal((await request(calendar, controlToken, workspaceId, controlPath)).status, 200);
  assert.equal((await request(calendar, token, workspaceId, controlPath)).status, 401);
  assert.equal((await request(calendar)).status, 400);
  for (const injection of [{ ownerId }, { plan: {} }, { sendUpdates: undefined }]) {
    assert.equal(
      (await request({ ...calendar, ...injection }, controlToken, workspaceId, controlPath)).status,
      400,
    );
  }
  assert.equal(calendarCalls, 1);
  const deviceCommand = {
    version: 1,
    command: "devices.command",
    id: randomUUID(),
    key: "native",
    operation: { kind: "command", executable: "/bin/echo", arguments: ["test"], directory: "/tmp" },
  };
  assert.equal((await request(deviceCommand, token, workspaceId, controlPath)).status, 401);
  const routed = await request(deviceCommand, controlToken, workspaceId, controlPath);
  assert.equal(routed.status, 200);
  assert.equal(
    routed.headers.get("fly-replay"),
    "instance=abcdef123456;timeout=2s;fallback=force_self",
  );
  assert.equal(
    (await request({ version: 1, command: "devices.result", id: randomUUID() })).status,
    200,
  );
  assert.equal(deviceCalls, 2);
  assert.equal((await request({ version: 1, command: "responsibilities.list" })).status, 200);
  const proposal = {
    version: 1,
    command: "responsibilities.propose",
    key: "fixture",
    purpose: "Watch changes",
    scope: [],
  };
  assert.equal((await request(proposal, controlToken, workspaceId, controlPath)).status, 200);
  assert.equal(
    (await request({ ...proposal, sourceMessageIds: [] }, controlToken, workspaceId, controlPath))
      .status,
    400,
  );
  assert.equal(
    (
      await request(
        { version: 1, command: "responsibilities.agree", id: randomUUID(), revision: 0 },
        controlToken,
        workspaceId,
        controlPath,
      )
    ).status,
    400,
  );
  assert.equal(responsibilityCalls, 2);
  assert.equal((await request({ version: 1, command: "schedules.list" })).status, 200);
  const cancelSchedule = { version: 1, command: "schedules.cancel", id: randomUUID(), revision: 1 };
  assert.equal((await request(cancelSchedule, token, workspaceId, controlPath)).status, 401);
  assert.equal((await request(cancelSchedule, controlToken, workspaceId, controlPath)).status, 200);
  assert.equal(scheduleCalls, 2);
  const file = { version: 1, command: "files.send", id: randomUUID(), key: "file" };
  assert.equal((await request(file, token, workspaceId, controlPath)).status, 401);
  assert.equal((await request(file, controlToken, workspaceId, controlPath)).status, 200);
  assert.equal(
    (await request({ version: 1, command: "files.status", id: randomUUID() })).status,
    200,
  );
  assert.equal(fileCalls, 2);
  assert.equal(
    (await request({ ...read, key: "read-fixture" }, controlToken, workspaceId, controlPath))
      .status,
    200,
  );
  assert.equal(
    (await request({ ...read, key: "read-fixture" }, token, workspaceId, controlPath)).status,
    401,
  );
  assert.equal((await request(cancellation, token, workspaceId, controlPath)).status, 401);
  assert.equal((await request(cancellation, controlToken)).status, 401);
  assert.equal(
    (await request({ version: 1, command: "devices.list" }, controlToken, workspaceId, controlPath))
      .status,
    400,
  );
  const response = await request(cancellation, controlToken, workspaceId, controlPath);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    version: 1,
    status: "waiting",
    message: "Cancellation requested.",
  });
  assert.equal(cancellations, 1);
  assert.equal(calls, 1);
});
