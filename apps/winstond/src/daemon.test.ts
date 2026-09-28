import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@winston/shared/logger";
import { createDaemon } from "./daemon.ts";
import { createExecutor } from "./exec.ts";
import { tokenStore } from "./token-store.ts";

const logger = createLogger("winstond-test", {
  pretty: false,
  destination: { write: () => undefined },
});

interface FakeSocketData {
  token: string;
}

/**
 * A fake gateway: accepts `reg-1` once as a registration token (answering
 * with VM token `vm-1`), and `vm-1` as a VM token. Records every connection
 * and frame.
 */
function fakeGateway() {
  const connections: {
    token: string;
    frames: { type: string }[];
    ws: import("bun").ServerWebSocket<FakeSocketData>;
  }[] = [];
  let registrationSpent = false;
  const server = Bun.serve<FakeSocketData>({
    port: 0,
    fetch(request, srv) {
      const token =
        request.headers.get("Authorization")?.replace("Bearer ", "") ?? "";
      const allowed =
        token === "vm-1" || (token === "reg-1" && !registrationSpent);
      if (!allowed) return new Response("unauthorized", { status: 401 });
      return srv.upgrade(request, { data: { token } })
        ? undefined
        : new Response("no", { status: 400 });
    },
    websocket: {
      open(ws) {
        connections.push({ token: ws.data.token, frames: [], ws });
        if (ws.data.token === "reg-1") {
          registrationSpent = true;
          ws.send(
            JSON.stringify({ id: "r1", type: "registered", vmToken: "vm-1" }),
          );
        }
      },
      message(ws, message) {
        connections
          .find((connection) => connection.ws === ws)
          ?.frames.push(JSON.parse(String(message)) as { type: string });
      },
    },
  });
  return { server, connections, url: `ws://localhost:${String(server.port)}` };
}

async function eventually(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 200; i += 1) {
    if (await check()) return;
    await Bun.sleep(10);
  }
  throw new Error("condition never became true");
}

const running: { stop: () => void }[] = [];
afterEach(() => {
  for (const item of running.splice(0)) item.stop();
});

async function start(
  url: string,
  registrationToken: string | undefined,
  tokenPath?: string,
) {
  const path =
    tokenPath ?? join(await mkdtemp(join(tmpdir(), "winstond-")), "token");
  const daemon = createDaemon({
    gatewayUrl: url,
    registrationToken,
    tokens: tokenStore(path),
    executor: createExecutor({ prefix: [] }),
    versions: { winstond: "0.1.0", cli: null },
    logger,
    backoff: () => 20,
    pingEveryMs: 50,
  });
  daemon.start();
  running.push(daemon);
  return { daemon, path };
}

describe("winstond", () => {
  test("first boot: registers, stores the VM token, then says hello and pings", async () => {
    const gateway = fakeGateway();
    running.push({ stop: () => void gateway.server.stop(true) });
    const { path } = await start(gateway.url, "reg-1");
    await eventually(
      () =>
        gateway.connections[0]?.frames.some((frame) => frame.type === "ping") ??
        false,
    );
    expect(await tokenStore(path).read()).toBe("vm-1");
    expect(gateway.connections[0]?.frames[0]).toMatchObject({
      type: "hello",
      winstondVersion: "0.1.0",
      cliVersion: null,
    });
  });

  test("later boots use the stored token, even with a stale registration token around", async () => {
    const gateway = fakeGateway();
    running.push({ stop: () => void gateway.server.stop(true) });
    const dir = await mkdtemp(join(tmpdir(), "winstond-"));
    await tokenStore(join(dir, "token")).write("vm-1");
    await start(gateway.url, "reg-stale", join(dir, "token"));
    await eventually(
      () =>
        gateway.connections[0]?.frames.some(
          (frame) => frame.type === "hello",
        ) ?? false,
    );
    expect(gateway.connections.map((connection) => connection.token)).toEqual([
      "vm-1",
    ]);
  });

  test("a refused stored token falls back to the registration token (a re-provisioned VM)", async () => {
    const gateway = fakeGateway();
    running.push({ stop: () => void gateway.server.stop(true) });
    const dir = await mkdtemp(join(tmpdir(), "winstond-"));
    await tokenStore(join(dir, "token")).write("vm-old");
    await start(gateway.url, "reg-1", join(dir, "token"));
    await eventually(
      async () => (await tokenStore(join(dir, "token")).read()) === "vm-1",
    );
  });

  test("reconnects after its connection is replaced or dropped", async () => {
    const gateway = fakeGateway();
    running.push({ stop: () => void gateway.server.stop(true) });
    await start(gateway.url, "reg-1");
    await eventually(
      () =>
        gateway.connections.length === 1 &&
        gateway.connections[0]?.frames.length !== 0,
    );
    gateway.connections[0]?.ws.close(4000, "replaced by a newer connection");
    await eventually(() => gateway.connections.length === 2);
    await eventually(
      () =>
        gateway.connections[1]?.frames.some(
          (frame) => frame.type === "hello",
        ) ?? false,
    );
    expect(gateway.connections[1]?.token).toBe("vm-1");
  });
});
