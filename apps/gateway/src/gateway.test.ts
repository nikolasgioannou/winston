import { afterAll, describe, expect, test } from "bun:test";
import { users, vms } from "@winston/db/schema";
import { insertUser, testDb } from "@winston/db/testing";
import { applyVmEvent } from "@winston/db/vm-state";
import { createVm, issueRegistrationToken } from "@winston/db/vms";
import type { GatewayToVmFrame } from "@winston/domain/frames";
import { createLogger } from "@winston/shared/logger";
import { hashToken } from "@winston/shared/tokens";
import { eq, inArray, sql } from "drizzle-orm";
import { replacedCloseCode } from "./connections.ts";
import { createGateway } from "./gateway.ts";
import { sweepVms } from "./liveness.ts";
import type { VmSocketData } from "./vm-socket.ts";

// The server handles requests on its own connections, so these tests commit
// real rows and delete their users afterwards.
const db = await testDb();
const logger = createLogger("gateway-test", {
  pretty: false,
  destination: { write: () => undefined },
});
const internalSecret = "internal-secret-0123456789abcdefghijklmnop";
const gateway = createGateway({ db, logger, internalSecret });
const server = Bun.serve<VmSocketData>({
  port: 0,
  fetch: gateway.fetch,
  websocket: gateway.websocket,
});
const createdUsers: string[] = [];

afterAll(async () => {
  await server.stop(true);
  if (createdUsers.length > 0)
    await db.delete(users).where(inArray(users.id, createdUsers));
});

/** A user with a VM waiting to register, and its registration token. */
async function registeringVm() {
  const user = await insertUser(db);
  createdUsers.push(user.id);
  const vm = await createVm(db, user.id, "docker");
  await applyVmEvent(db, vm.id, "provision");
  const registrationToken = await issueRegistrationToken(db, vm.id);
  await applyVmEvent(db, vm.id, "provisioned");
  return { userId: user.id, vmId: vm.id, registrationToken };
}

interface Client {
  ws: WebSocket;
  frames: GatewayToVmFrame[];
  closed: Promise<number>;
  send: (frame: Record<string, unknown>) => void;
  /** Resolves with the next frame of this type. */
  next: (type: GatewayToVmFrame["type"]) => Promise<GatewayToVmFrame>;
}

/** Connects like winstond does. Rejects if the gateway refuses the connection. */
function connect(token: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://localhost:${String(server.port)}/vm/connect`,
      {
        headers: { Authorization: `Bearer ${token}` },
      } as unknown as string[],
    );
    const frames: GatewayToVmFrame[] = [];
    const waiters: {
      type: string;
      resolve: (frame: GatewayToVmFrame) => void;
    }[] = [];
    let opened = false;
    const closed = new Promise<number>((resolveClose) => {
      ws.addEventListener("close", (event) => {
        if (!opened) reject(new Error(`refused (${String(event.code)})`));
        resolveClose(event.code);
      });
    });
    ws.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as GatewayToVmFrame;
      frames.push(frame);
      const index = waiters.findIndex((waiter) => waiter.type === frame.type);
      if (index >= 0) waiters.splice(index, 1)[0]?.resolve(frame);
    });
    ws.addEventListener("open", () => {
      opened = true;
      resolve({
        ws,
        frames,
        closed,
        send: (frame) => {
          ws.send(JSON.stringify(frame));
        },
        next: (type) => {
          const seen = frames.find((frame) => frame.type === type);
          if (seen) return Promise.resolve(seen);
          return new Promise((resolveFrame) =>
            waiters.push({ type, resolve: resolveFrame }),
          );
        },
      });
    });
  });
}

const vmRow = async (vmId: string) =>
  (await db.select().from(vms).where(eq(vms.id, vmId)))[0];

/** Polls until `check` passes (the gateway handles frames asynchronously). */
async function eventually(check: () => Promise<boolean>) {
  for (let i = 0; i < 100; i += 1) {
    if (await check()) return;
    await Bun.sleep(10);
  }
  throw new Error("condition never became true");
}

const hello = {
  id: "h1",
  type: "hello",
  cliVersion: "0.1.0",
  winstondVersion: "0.1.0",
  capabilities: [],
};

describe("gateway", () => {
  test("a registration token is exchanged once for a VM token, and hello makes the VM ready", async () => {
    const { vmId, registrationToken } = await registeringVm();
    const client = await connect(registrationToken);
    const registered = await client.next("registered");
    if (registered.type !== "registered")
      throw new Error("expected registered");

    const row = await vmRow(vmId);
    expect(row?.tokenHash).toBe(hashToken(registered.vmToken));
    expect(row?.registrationTokenHash).toBeNull();

    client.send(hello);
    await eventually(async () => (await vmRow(vmId))?.state === "ready");
    expect(await vmRow(vmId)).toMatchObject({
      cliVersion: "0.1.0",
      winstondVersion: "0.1.0",
    });
    client.ws.close();

    // The registration token is spent; the VM token works.
    const reused = await connect(registrationToken).catch((e: unknown) => e);
    expect(reused).toBeInstanceOf(Error);
    const again = await connect(registered.vmToken);
    again.ws.close();
  });

  test("an unknown token is refused", async () => {
    const error = await connect("not-a-real-token").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
  });

  test("two simultaneous registrations with one token: exactly one gets a VM token", async () => {
    const { registrationToken } = await registeringVm();
    const [a, b] = await Promise.all([
      connect(registrationToken),
      connect(registrationToken),
    ]);
    const outcomes = await Promise.race([
      Promise.all([
        a.next("registered").then(() => "registered"),
        b.closed.then((code) => `closed ${String(code)}`),
      ]),
      Promise.all([
        b.next("registered").then(() => "registered"),
        a.closed.then((code) => `closed ${String(code)}`),
      ]),
    ]);
    expect(outcomes).toEqual(["registered", "closed 4401"]);
    a.ws.close();
    b.ws.close();
  });

  test("a new connection replaces the old one", async () => {
    const { registrationToken } = await registeringVm();
    const first = await connect(registrationToken);
    const registered = await first.next("registered");
    if (registered.type !== "registered")
      throw new Error("expected registered");
    const second = await connect(registered.vmToken);
    expect(await first.closed).toBe(replacedCloseCode);
    second.ws.close();
  });

  test("malformed frames get an error frame; ping gets a pong and updates last_seen_at", async () => {
    const { vmId, registrationToken } = await registeringVm();
    const client = await connect(registrationToken);
    await client.next("registered");

    client.ws.send("{nope");
    const error = await client.next("error");
    expect(error).toMatchObject({ type: "error", code: "invalid_frame" });

    client.send({ id: "p1", type: "ping" });
    const pong = await client.next("pong");
    expect(pong).toMatchObject({ type: "pong", replyTo: "p1" });
    expect((await vmRow(vmId))?.lastSeenAt).toBeInstanceOf(Date);
    client.ws.close();
  });

  test("the sweep marks silent VMs unhealthy and stuck ones failed; a ping recovers", async () => {
    const silent = await registeringVm();
    const client = await connect(silent.registrationToken);
    await client.next("registered");
    client.send(hello);
    await eventually(async () => (await vmRow(silent.vmId))?.state === "ready");
    await db
      .update(vms)
      .set({ lastSeenAt: sql`now() - interval '3 minutes'` })
      .where(eq(vms.id, silent.vmId));

    const stuck = await registeringVm();
    await db
      .update(vms)
      .set({ stateChangedAt: sql`now() - interval '11 minutes'` })
      .where(eq(vms.id, stuck.vmId));

    await sweepVms(db, logger);
    expect((await vmRow(silent.vmId))?.state).toBe("unhealthy");
    expect((await vmRow(stuck.vmId))?.state).toBe("failed");

    client.send({ id: "p2", type: "ping" });
    await eventually(async () => (await vmRow(silent.vmId))?.state === "ready");
    client.ws.close();
  });

  test("the internal API needs the secret and reports a VM's status", async () => {
    const { userId, registrationToken } = await registeringVm();
    const url = `http://localhost:${String(server.port)}/internal/vms/${userId}/status`;
    expect((await fetch(url)).status).toBe(401);
    expect(
      (await fetch(url, { headers: { Authorization: "Bearer wrong" } })).status,
    ).toBe(401);

    const client = await connect(registrationToken);
    await client.next("registered");
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${internalSecret}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      state: "registering",
      connected: true,
    });
    client.ws.close();

    const missing = await fetch(
      `http://localhost:${String(server.port)}/internal/vms/usr_nobody/status`,
      {
        headers: { Authorization: `Bearer ${internalSecret}` },
      },
    );
    expect(missing.status).toBe(404);
  });
});

/** A registered VM ready for commands: its user id, VM token and live client. */
async function readyVm() {
  const vm = await registeringVm();
  const client = await connect(vm.registrationToken);
  const registered = await client.next("registered");
  if (registered.type !== "registered") throw new Error("expected registered");
  client.send(hello);
  await eventually(async () => (await vmRow(vm.vmId))?.state === "ready");
  return { ...vm, client, vmToken: registered.vmToken };
}

const execUrl = (userId: string) =>
  `http://localhost:${String(server.port)}/internal/vms/${userId}/exec`;
const postExec = (userId: string, body: Record<string, unknown>) =>
  fetch(execUrl(userId), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${internalSecret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

describe("gateway exec", () => {
  test("sends the command and returns the streamed output and exit code", async () => {
    const { userId, client } = await readyVm();
    const response = postExec(userId, {
      cmd: "echo hi",
      env: { WINSTON_RUN_TOKEN: "run-1" },
      timeoutMs: 5_000,
    });
    const exec = await client.next("exec");
    if (exec.type !== "exec") throw new Error("expected exec");
    expect(exec).toMatchObject({
      cmd: "echo hi",
      env: { WINSTON_RUN_TOKEN: "run-1" },
      timeoutMs: 5_000,
    });
    client.send({
      id: "o1",
      type: "exec.output",
      execId: exec.id,
      stream: "stdout",
      data: "h",
    });
    client.send({
      id: "o2",
      type: "exec.output",
      execId: exec.id,
      stream: "stdout",
      data: "i\n",
    });
    client.send({
      id: "o3",
      type: "exec.output",
      execId: exec.id,
      stream: "stderr",
      data: "warn\n",
    });
    client.send({
      id: "x1",
      type: "exec.exit",
      execId: exec.id,
      exitCode: 2,
      timedOut: false,
      truncated: false,
    });
    const result = await response;
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({
      stdout: "hi\n",
      stderr: "warn\n",
      exitCode: 2,
      timedOut: false,
      truncated: false,
    });
    client.ws.close();
  });

  test("a VM that isn't connected gets a clear error", async () => {
    const { userId, client } = await readyVm();
    client.ws.close();
    await client.closed;
    // The server notices the close a moment after the client does.
    await Bun.sleep(50);
    const response = await postExec(userId, {
      cmd: "echo hi",
      timeoutMs: 5_000,
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "vm_unavailable" },
    });
  });

  test("after a reconnect mid-command, the buffered result is fetched instead of rerunning it", async () => {
    const { userId, client, vmToken } = await readyVm();
    const response = postExec(userId, { cmd: "make coffee", timeoutMs: 5_000 });
    const exec = await client.next("exec");
    client.send({
      id: "o1",
      type: "exec.output",
      execId: exec.id,
      stream: "stdout",
      data: "partial",
    });
    client.ws.close();
    await client.closed;

    const again = await connect(vmToken);
    const fetchFrame = await again.next("exec.fetch");
    expect(fetchFrame).toMatchObject({ type: "exec.fetch", execId: exec.id });
    expect(again.frames.some((frame) => frame.type === "exec")).toBe(false);
    again.send({
      id: "r1",
      type: "exec.result",
      execId: exec.id,
      found: true,
      stdout: "partial and the rest\n",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      truncated: false,
    });
    expect(await (await response).json()).toMatchObject({
      stdout: "partial and the rest\n",
      exitCode: 0,
    });
    again.ws.close();
  });

  test("the exec endpoint rejects bad requests and needs the secret", async () => {
    const { userId, client } = await readyVm();
    expect((await postExec(userId, { cmd: "", timeoutMs: 5_000 })).status).toBe(
      400,
    );
    expect(
      (
        await postExec(userId, {
          cmd: "ls",
          env: { "bad-key": "x" },
          timeoutMs: 5_000,
        })
      ).status,
    ).toBe(400);
    const noSecret = await fetch(execUrl(userId), {
      method: "POST",
      body: "{}",
    });
    expect(noSecret.status).toBe(401);
    client.ws.close();
  });
});
