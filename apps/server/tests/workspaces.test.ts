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
    issueCli: unused,
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

test("command and recovery routes enforce distinct scopes and carry exact dispatch proof", async () => {
  const ownerId = randomUUID();
  const workspaceId = randomUUID();
  const subjectId = randomUUID();
  const operation = {
    version: 1 as const,
    identity: { ownerId, workspaceId },
    operationId: randomUUID(),
    taskId: randomUUID(),
    revision: 1,
    generation: 1,
    kind: "command:execute" as const,
    inputHash: "a".repeat(64),
  };
  const command = {
    operation,
    input: {
      argv: ["echo", "fixture"],
      cwd: "/data/home",
      env: {},
      timeoutMs: 1000,
      maxOutputBytes: 1024,
    },
    dispatch: { id: randomUUID(), token: `wda_${"d".repeat(43)}` },
  };
  const tokens = {
    "workspace:execute": `wst_${"a".repeat(43)}`,
    "workspace:observe": `wst_${"b".repeat(43)}`,
    "workspace:cancel": `wst_${"c".repeat(43)}`,
  };
  let allowed = true;
  let calls = 0;
  const grant = () => {
    calls += 1;
    return Promise.resolve(
      allowed
        ? { version: 1 as const, allowed: true as const, operation, workspaceRevision: 1 }
        : null,
    );
  };
  const unused = () => Promise.reject(new Error("Unexpected repository call"));
  const workspaces: OwnerTransaction["workspaces"] = {
    find: unused,
    register: unused,
    setState: unused,
    issueExecution: unused,
    issueControl: unused,
    authorize: unused,
    issueCli: unused,
    authorizeCommand(request, received) {
      expect(request.operation).toBe("workspace:execute");
      expect(received).toEqual(command);
      return grant();
    },
    authorizeControl(request, received) {
      expect(["workspace:observe", "workspace:cancel"]).toContain(request.operation);
      expect(received).toEqual(operation);
      return grant();
    },
  };
  const database = {
    authenticateService: (input: ServiceRequest) =>
      Promise.resolve(
        input.subjectId === subjectId &&
          input.resourceId === workspaceId &&
          input.token === tokens[input.operation as keyof typeof tokens]
          ? {
              ...input,
              ownerId,
              taskId: operation.taskId,
              revision: 1,
              generation: 1,
              credential: null,
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
  const send = (path: string, token: string, body: unknown) =>
    app.request(`/api/tasks/workspaces/${workspaceId}/${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Winston-Worker": subjectId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  expect((await send("authorize-command", tokens["workspace:execute"], command)).status).toBe(200);
  for (const mode of ["observe", "cancel"] as const) {
    const response = await send(`authorize-${mode}`, tokens[`workspace:${mode}`], operation);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect((await send("authorize-command", tokens[`workspace:${mode}`], command)).status).toBe(
      401,
    );
    expect((await send(`authorize-${mode}`, tokens["workspace:execute"], operation)).status).toBe(
      401,
    );
  }
  expect(
    (
      await send("authorize-command", tokens["workspace:execute"], {
        ...command,
        dispatch: undefined,
      })
    ).status,
  ).toBe(400);
  expect(calls).toBe(3);
  allowed = false;
  expect((await send("authorize-command", tokens["workspace:execute"], command)).status).toBe(403);
  expect((await send("authorize-cancel", tokens["workspace:cancel"], operation)).status).toBe(403);
  for (const secret of [...Object.values(tokens), command.dispatch.token])
    expect(JSON.stringify(logs)).not.toContain(secret);
});
