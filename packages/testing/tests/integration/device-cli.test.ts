import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import {
  cliResultSchema,
  cliDeviceResultSchema,
  type CliDeviceRequest,
} from "@winston/contracts/cli";
import { decodeDeviceMessage, type DeviceMessage } from "@winston/contracts/devices";
import { createDeviceCli } from "../../../../apps/server/src/devices/cli";
import { createDeviceDispatcher } from "../../../../apps/server/src/devices/dispatch";
import { withTestPostgres } from "../../src/postgres";

test("device CLI connects approval, single dispatch, task-scoped output and cancellation", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    try {
      const ownerId = randomUUID();
      const workspaceId = randomUUID();
      const server = { serverId: randomUUID(), machineId: null };
      const setup = await database.transaction(
        ownerId,
        async ({ owners, workspaces, tasks, devices, deviceSessions }) => {
          await owners.ensure();
          await workspaces.register(workspaceId, "CLI fixture");
          await workspaces.setState(workspaceId, 0, "active");
          const queued = await tasks.create({
            key: randomUUID(),
            objective: "Device CLI fixture",
            sourceMessageIds: [],
          });
          const running = await tasks.claim(queued.id, queued.revision);
          const challenge = await devices.start("CLI computer");
          const pair = await devices.pair(challenge.secret, {
            platform: "macos",
            appVersion: "0.1.0",
            protocolVersion: 1,
            capabilities: ["command"],
          });
          assert.ok(pair);
          const opened = await deviceSessions.open(pair.device.id, pair.credential, server);
          assert.ok(opened);
          const session = {
            deviceId: opened.deviceId,
            sessionId: opened.sessionId,
            generation: opened.generation,
          };
          await deviceSessions.advertise(session, ["command"]);
          await deviceSessions.heartbeat(session, "ready");
          return {
            worker: { id: running.id, revision: running.revision, generation: running.generation },
            session,
          };
        },
      );
      let worker = setup.worker;
      const issue = async (operation: "gateway:read" | "gateway:control", task = worker) => {
        const grant = await database.transaction(ownerId, ({ capabilities }) =>
          capabilities.issue(
            {
              kind: "workspace",
              subjectId: workspaceId,
              resourceId: workspaceId,
              resourceRevision: 1,
              taskId: task.id,
              revision: task.revision,
              generation: task.generation,
              operation,
              credential: null,
            },
            300,
          ),
        );
        return {
          token: grant.token,
          kind: "workspace" as const,
          subjectId: workspaceId,
          resourceId: workspaceId,
          operation,
        };
      };
      let open = true;
      let failSend = false;
      const sent: DeviceMessage[] = [];
      const dispatch = createDeviceDispatcher(database, {
        serverId: server.serverId,
        channel: () =>
          open
            ? {
                isOpen: () => open,
                send: (frame) => {
                  sent.push(decodeDeviceMessage(frame));
                  if (failSend) throw new Error("Unknown send outcome");
                  return 1;
                },
                close: () => {
                  open = false;
                },
              }
            : null,
      });
      const gateway = createDeviceCli({ database, dispatch, server });
      let control = await issue("gateway:control");
      let read = await issue("gateway:read");
      const request: Extract<CliDeviceRequest, { command: "devices.command" }> = {
        version: 1,
        command: "devices.command",
        id: setup.session.deviceId,
        key: "one-command",
        operation: {
          kind: "command",
          executable: "/bin/echo",
          arguments: ["literal; $(unchanged)"],
          directory: "/tmp",
        },
      };
      const call = async (
        input: CliDeviceRequest,
        credential = input.command === "devices.command" ? control : read,
      ) =>
        cliResultSchema.parse(
          await (
            await gateway(credential, input, new Headers(), new AbortController().signal)
          ).json(),
        );
      assert.equal((await call(request, read)).status, "denied");
      const approval = await call(request);
      assert.equal(approval.status, "approval_required");
      assert.ok(approval.referenceId);
      const approvalId = approval.referenceId;
      assert.equal(sent.length, 0);
      worker = await database.transaction(ownerId, async ({ actions, tasks }) => {
        const action = await actions.find(approvalId);
        const waiting = await tasks.find(worker.id);
        assert.ok(action && waiting);
        assert.equal(waiting.state, "waiting");
        await actions.decide({
          id: action.id,
          revision: action.revision,
          hash: action.hash,
          approve: true,
        });
        const queued = await tasks.resume(waiting.id, waiting.revision, action.id);
        const running = await tasks.claim(queued.id, queued.revision);
        return { id: running.id, revision: running.revision, generation: running.generation };
      });
      control = await issue("gateway:control");
      read = await issue("gateway:read");
      const started = await call(request);
      assert.equal(started.status, "ok");
      const running = cliDeviceResultSchema.parse(started.data);
      assert.equal(running.id, approval.referenceId);
      assert.equal(running.state, "dispatching");
      assert.equal(sent.length, 1);
      assert.equal((await call(request)).status, "ok");
      assert.equal(sent.length, 1);
      assert.equal(
        (await call({ ...request, operation: { ...request.operation, arguments: ["changed"] } }))
          .status,
        "invalid_input",
      );
      const original = sent[0];
      assert.ok(original);
      assert.equal(original.payload.kind, "execute");
      const evidence = (
        state: "succeeded" | "canceled",
        sequence: number,
        message = original,
      ): DeviceMessage => {
        assert.equal(message.payload.kind, "execute");
        return {
          ...message,
          messageId: randomUUID(),
          correlationId: message.messageId,
          payload: {
            kind: "status",
            executionId: message.payload.executionId,
            taskId: message.payload.taskId,
            taskRevision: message.payload.taskRevision,
            sequence,
            state,
            exitCode: state === "succeeded" ? 0 : null,
          },
        };
      };
      await database.transaction(ownerId, async ({ deviceExecutions }) => {
        assert.equal(original.payload.kind, "execute");
        await deviceExecutions.appendOutput({
          ...original,
          messageId: randomUUID(),
          correlationId: original.messageId,
          payload: {
            kind: "output",
            executionId: original.payload.executionId,
            taskId: worker.id,
            taskRevision: worker.revision,
            sequence: 1,
            stream: "stdout",
            text: "literal; $(unchanged)\n",
          },
        });
        await deviceExecutions.receipt(evidence("succeeded", 2));
      });
      const finished = await call({
        version: 1,
        command: "devices.result",
        id: running.id,
        after: -1,
      });
      assert.equal(finished.status, "ok");
      const receipt = cliDeviceResultSchema.parse(finished.data);
      assert.equal(receipt.state, "succeeded");
      assert.equal(receipt.exitCode, 0);
      assert.equal(receipt.output[0]?.text, "literal; $(unchanged)\n");
      const page = await call({
        version: 1,
        command: "devices.result",
        id: running.id,
        after: receipt.afterSequence,
      });
      assert.equal(page.status, "ok");
      assert.deepEqual(cliDeviceResultSchema.parse(page.data).output, []);
      const unrelated = await database.transaction(ownerId, async ({ tasks }) => {
        const queued = await tasks.create({
          key: randomUUID(),
          objective: "Another task",
          sourceMessageIds: [],
        });
        const next = await tasks.claim(queued.id, queued.revision);
        return { id: next.id, revision: next.revision, generation: next.generation };
      });
      const foreignRead = await issue("gateway:read", unrelated);
      assert.equal(
        (
          await call(
            { version: 1, command: "devices.result", id: running.id, after: -1 },
            foreignRead,
          )
        ).status,
        "denied",
      );
      const otherOwner = randomUUID();
      const otherWorkspace = randomUUID();
      const otherCredential = await database.transaction(
        otherOwner,
        async ({ owners, workspaces, tasks, capabilities }) => {
          await owners.ensure();
          await workspaces.register(otherWorkspace, "Another owner");
          await workspaces.setState(otherWorkspace, 0, "active");
          const queued = await tasks.create({
            key: randomUUID(),
            objective: "Another owner's task",
            sourceMessageIds: [],
          });
          const task = await tasks.claim(queued.id, queued.revision);
          const credential = {
            kind: "workspace" as const,
            subjectId: otherWorkspace,
            resourceId: otherWorkspace,
            operation: "gateway:read" as const,
          };
          const grant = await capabilities.issue(
            {
              ...credential,
              resourceRevision: 1,
              taskId: task.id,
              revision: task.revision,
              generation: task.generation,
              credential: null,
            },
            300,
          );
          return { ...credential, token: grant.token };
        },
      );
      assert.equal(
        (
          await call(
            { version: 1, command: "devices.result", id: running.id, after: -1 },
            otherCredential,
          )
        ).status,
        "denied",
      );
      await database.transaction(ownerId, ({ authorization }) =>
        authorization.put({
          target: { kind: "device", id: request.id, resource: null },
          operation: "device.command",
          decision: "allow",
          revision: 0,
        }),
      );
      open = false;
      const offline = await call({ ...request, key: "offline" });
      assert.equal(offline.status, "unavailable");
      assert.ok(offline.referenceId);
      const offlineId = offline.referenceId;
      const offlineAction = await database.transaction(ownerId, ({ actions }) =>
        actions.find(offlineId),
      );
      assert.equal(offlineAction?.state, "approved");
      open = true;
      const active = await call({ ...request, key: "offline" });
      assert.equal(active.status, "ok");
      const activeId = cliDeviceResultSchema.parse(active.data).id;
      const activeMessage = sent.at(-1);
      assert.ok(activeMessage);
      const busy = await call({ ...request, key: "busy" });
      assert.equal(busy.status, "waiting");
      assert.ok(busy.referenceId);
      const busyId = busy.referenceId;
      const busyAction = await database.transaction(ownerId, ({ actions }) => actions.find(busyId));
      assert.equal(busyAction?.state, "approved");
      const unrelatedControl = await issue("gateway:control", unrelated);
      const unrelatedCancellation = await database.transaction(ownerId, ({ cli }) =>
        cli.cancel(unrelatedControl, activeId),
      );
      assert.equal(unrelatedCancellation.status, "denied");
      const canceled = await database.transaction(ownerId, ({ cli }) =>
        cli.cancel(control, activeId),
      );
      assert.equal(canceled.status, "waiting");
      const controls = await database.transaction(ownerId, ({ deviceExecutions }) =>
        deviceExecutions.planControls(setup.session),
      );
      assert.equal(controls[0]?.payload.kind, "cancel");
      await database.transaction(ownerId, ({ deviceExecutions }) =>
        deviceExecutions.receipt(evidence("canceled", 0, activeMessage)),
      );
      assert.equal((await call({ ...request, key: "busy" })).status, "ok");
      const busyMessage = sent.at(-1);
      assert.ok(busyMessage);
      await database.transaction(ownerId, ({ deviceExecutions }) =>
        deviceExecutions.receipt(evidence("succeeded", 0, busyMessage)),
      );
      failSend = true;
      const uncertain = await call({ ...request, key: "uncertain" });
      assert.equal(uncertain.status, "unknown");
      assert.ok(uncertain.referenceId);
      const count = sent.length;
      assert.equal((await call({ ...request, key: "uncertain" })).status, "ok");
      assert.equal(sent.length, count);
      await database.transaction(ownerId, ({ authorization }) =>
        authorization.put({
          target: { kind: "device", id: request.id, resource: null },
          operation: "device.command",
          decision: "deny",
          revision: 1,
        }),
      );
      assert.equal(
        (await call({ version: 1, command: "devices.result", id: running.id, after: -1 })).status,
        "denied",
      );
      await sql`UPDATE winston.service_capabilities SET expires_at = clock_timestamp() - interval '1 second' WHERE owner_id = ${ownerId}::uuid`;
      assert.equal((await call(request)).status, "denied");
    } finally {
      await database.close();
    }
  });
});
