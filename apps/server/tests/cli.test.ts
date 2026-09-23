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
  let calls = 0;
  const cli: OwnerTransaction["cli"] = {
    execute: () => {
      calls += 1;
      return Promise.resolve({ version: 1, status: "ok", data: [] });
    },
  };
  const database = {
    authenticateService: (input: ServiceRequest) =>
      Promise.resolve(
        input.token === token &&
          input.subjectId === workspaceId &&
          input.resourceId === workspaceId &&
          input.operation === "gateway:read" &&
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
  const request = (body: unknown, bearer = token, workspace = workspaceId) =>
    app.request("/api/tasks/cli", {
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
  assert.equal(calls, 1);
});
