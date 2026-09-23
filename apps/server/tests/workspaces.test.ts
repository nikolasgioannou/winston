import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { OwnerTransaction } from "@winston/adapters/database";
import type { ServiceRequest } from "@winston/contracts/capabilities";
import { createApi, type RequestLog } from "../src/http/app";
import { createWorkspaceTaskGroup } from "../src/http/workspaces";

test("workspace authorization has no owner issuance path and requires worker authority", async () => {
  const ownerId = randomUUID();
  const workspaceId = randomUUID();
  const workerId = randomUUID();
  const taskId = randomUUID();
  const token = `wst_${"x".repeat(43)}`;
  const operation = {
    version: 1 as const,
    identity: { ownerId, workspaceId },
    operationId: randomUUID(),
    taskId,
    revision: 1,
    generation: 2,
    kind: "workspace:inspect" as const,
    inputHash: "a".repeat(64),
  };
  let current = true;
  const unused = () => Promise.reject(new Error("This method must not be exposed."));
  const workspaces: OwnerTransaction["workspaces"] = {
    find: unused,
    register: unused,
    setState: unused,
    issueExecution: unused,
    issueControl: unused,
    authorizeCommand: unused,
    authorizeControl: unused,
    authorize: (_request, input) =>
      Promise.resolve(
        current
          ? { version: 1 as const, allowed: true as const, operation: input, workspaceRevision: 1 }
          : null,
      ),
  };
  const database = {
    authenticateService: (input: ServiceRequest) =>
      Promise.resolve(
        input.token === token &&
          input.subjectId === workerId &&
          input.resourceId === workspaceId &&
          input.kind === "worker" &&
          input.operation === "workspace:execute"
          ? {
              ...input,
              ownerId,
              taskId,
              revision: 1,
              generation: 2,
              credential: null,
              resourceRevision: 1,
              capabilityId: randomUUID(),
            }
          : null,
      ),
    transaction: <Result>(
      _ownerId: string,
      work: (scope: Pick<OwnerTransaction, "workspaces">) => Promise<Result>,
    ) => work({ workspaces }),
  };
  const logs: RequestLog[] = [];
  const { app } = createApi({
    groups: { task: createWorkspaceTaskGroup(database) },
    log: (entry) => {
      logs.push(entry);
    },
  });
  const endpoint = `/api/tasks/workspaces/${workspaceId}/authorize`;
  const send = (body: unknown = operation, bearer = token) =>
    app.request(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "X-Winston-Worker": workerId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  expect((await send()).status).toBe(200);
  expect((await send(operation, "owner-session")).status).toBe(401);
  expect((await send({ ...operation, extra: "not allowed" })).status).toBe(400);
  expect((await app.request("/api/owner/workspaces/issue", { method: "POST" })).status).toBe(403);
  expect((await app.request(endpoint)).status).toBe(401);
  current = false;
  expect((await send()).status).toBe(403);
  expect(JSON.stringify(logs)).not.toContain(token);
  expect(JSON.stringify(logs)).not.toContain(workspaceId);
});
