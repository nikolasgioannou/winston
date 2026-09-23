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
  const cli: OwnerTransaction["cli"] = {
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
  const { app } = createApi({ groups: { task: createCliTaskGroup(database) } });
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
  const controlPath = "/api/tasks/cli/control";
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
