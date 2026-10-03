import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@winston/shared/logger";
import { serveCliSocket } from "./cli-socket.ts";
import { createDaemon } from "./daemon.ts";
import { createExecutor } from "./exec.ts";
import { localFiles } from "./files.ts";
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
        const frame = JSON.parse(String(message)) as {
          id: string;
          type: string;
          path?: string;
          runToken?: string;
        };
        if (frame.type === "rpc.request")
          ws.send(
            JSON.stringify({
              id: `resp-${frame.id}`,
              type: "rpc.response",
              replyTo: frame.id,
              status: 200,
              body: JSON.stringify({
                path: frame.path,
                runToken: frame.runToken,
              }),
            }),
          );
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
  filesRoot?: string,
) {
  const path =
    tokenPath ?? join(await mkdtemp(join(tmpdir(), "winstond-")), "token");
  const daemon = createDaemon({
    gatewayUrl: url,
    registrationToken,
    tokens: tokenStore(path),
    executor: createExecutor({ prefix: [] }),
    files: localFiles(filesRoot ?? tmpdir()),
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
  test("an update: a new CLI is announced at once; a new winstond restarts once idle", async () => {
    const gateway = fakeGateway();
    running.push({ stop: () => void gateway.server.stop(true) });
    const applied: string[] = [];
    let restarts = 0;
    let confirms = 0;
    let replacesWinstond = false;
    let idle = false;
    const daemon = createDaemon({
      gatewayUrl: gateway.url,
      registrationToken: "reg-1",
      tokens: tokenStore(
        join(await mkdtemp(join(tmpdir(), "winstond-")), "token"),
      ),
      executor: createExecutor({ prefix: [] }),
      files: localFiles(tmpdir()),
      versions: { winstond: "0.1.1+a", cli: "0.1.1+a" },
      updates: {
        apply: (frame) => {
          applied.push(frame.version);
          return Promise.resolve({
            cliUpdated: true,
            winstondUpdated: replacesWinstond,
          });
        },
        confirm: () => {
          confirms++;
          return Promise.resolve();
        },
        restart: () => {
          restarts++;
        },
        idle: () => idle,
        idleCheckMs: 10,
      },
      logger,
      backoff: () => 20,
      pingEveryMs: 50,
    });
    daemon.start();
    running.push(daemon);
    const hellos = () =>
      (gateway.connections[0]?.frames ?? []).filter(
        (frame) => frame.type === "hello",
      ) as unknown as { cliVersion: string | null }[];
    await eventually(() => hellos().length === 1);
    expect(confirms).toBe(1);

    const binary = {
      url: "https://s3/x",
      sha256: "0".repeat(64),
      signature: "c2ln",
    };
    const announce = (version: string) => {
      gateway.connections[0]?.ws.send(
        JSON.stringify({
          id: `u-${version}`,
          type: "update.available",
          version,
          binaries: { winston: binary, winstond: binary },
        }),
      );
    };
    announce("0.1.2+b");
    await eventually(() => hellos().length === 2);
    expect(hellos()[1]?.cliVersion).toBe("0.1.2+b");
    expect(restarts).toBe(0);

    replacesWinstond = true;
    announce("0.1.3+c");
    // The new CLI is announced before winstond's restart, which waits while
    // a command runs (or its result is still wanted). Only a new winstond
    // that connects confirms its own update.
    await eventually(() => hellos().length === 3);
    expect(hellos()[2]?.cliVersion).toBe("0.1.3+c");
    await Bun.sleep(100);
    expect(restarts).toBe(0);
    idle = true;
    await eventually(() => restarts === 1);
    expect(confirms).toBe(1);
    expect(applied).toEqual(["0.1.2+b", "0.1.3+c"]);
  });

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

describe("winstond file transfers", () => {
  test("an upload in chunks lands intact, and reads back byte for byte; escapes are refused", async () => {
    const gateway = fakeGateway();
    running.push({ stop: () => void gateway.server.stop(true) });
    const home = await realpath(
      await mkdtemp(join(tmpdir(), "winstond-home-")),
    );
    await start(gateway.url, "reg-1", undefined, home);
    await eventually(
      () =>
        gateway.connections[0]?.frames.some(
          (frame) => frame.type === "hello",
        ) ?? false,
    );
    const vm = gateway.connections[0];
    if (!vm) throw new Error("no connection");
    const frames = vm.frames as {
      type: string;
      transferId?: string;
      data?: string;
      code?: string;
    }[];

    const data = new Uint8Array(600 * 1024).map((_, i) => (i * 7) % 256);
    const digest = createHash("sha256").update(data).digest("hex");
    vm.ws.send(
      JSON.stringify({
        id: "w1",
        type: "file.write",
        path: "inbox/photo.jpg",
        size: data.length,
        sha256: digest,
      }),
    );
    for (let seq = 0, at = 0; at < data.length; seq += 1, at += 256 * 1024)
      vm.ws.send(
        JSON.stringify({
          id: `c${String(seq)}`,
          type: "file.chunk",
          transferId: "w1",
          seq,
          data: Buffer.from(data.subarray(at, at + 256 * 1024)).toString(
            "base64",
          ),
        }),
      );
    vm.ws.send(
      JSON.stringify({ id: "e1", type: "file.end", transferId: "w1" }),
    );
    await eventually(() => frames.some((frame) => frame.type === "file.done"));
    const written = new Uint8Array(
      await Bun.file(join(home, "inbox/photo.jpg")).arrayBuffer(),
    );
    expect(createHash("sha256").update(written).digest("hex")).toBe(digest);

    vm.ws.send(
      JSON.stringify({ id: "r1", type: "file.read", path: "inbox/photo.jpg" }),
    );
    await eventually(
      () => frames.filter((frame) => frame.type === "file.done").length === 2,
    );
    const chunks = frames.filter(
      (frame) => frame.type === "file.chunk" && frame.transferId === "r1",
    );
    const readBack = Buffer.concat(
      chunks.map((chunk) => Buffer.from(chunk.data ?? "", "base64")),
    );
    expect(createHash("sha256").update(readBack).digest("hex")).toBe(digest);
    expect(chunks.length).toBeGreaterThan(1);

    vm.ws.send(
      JSON.stringify({ id: "r2", type: "file.read", path: "../../etc/passwd" }),
    );
    await eventually(() => frames.some((frame) => frame.type === "file.error"));
    expect(frames.find((frame) => frame.type === "file.error")).toMatchObject({
      transferId: "r2",
      code: "outside_home",
    });
  });
});

describe("winstond CLI socket", () => {
  test("a call on the unix socket goes to the gateway with its run token, and the answer comes back", async () => {
    const gateway = fakeGateway();
    running.push({ stop: () => void gateway.server.stop(true) });
    const { daemon } = await start(gateway.url, "reg-1");
    await eventually(
      () =>
        gateway.connections[0]?.frames.some(
          (frame) => frame.type === "hello",
        ) ?? false,
    );
    const socketPath = join(
      await mkdtemp(join(tmpdir(), "winstond-sock-")),
      "winstond.sock",
    );
    const server = await serveCliSocket(socketPath, (request) =>
      daemon.rpc(request),
    );
    running.push({ stop: () => void server.stop(true) });

    const response = await fetch("http://winstond/v1/me?fields=all", {
      unix: socketPath,
      headers: { Authorization: "Bearer run-token-abc" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      path: "/v1/me?fields=all",
      runToken: "run-token-abc",
    });

    const outside = await fetch("http://winstond/internal/anything", {
      unix: socketPath,
    });
    expect(outside.status).toBe(404);
  });

  test("without a connection to the backend, calls get the standard unavailable error", async () => {
    const daemon = createDaemon({
      gatewayUrl: "ws://127.0.0.1:1",
      registrationToken: undefined,
      tokens: tokenStore(
        join(await mkdtemp(join(tmpdir(), "winstond-")), "token"),
      ),
      executor: createExecutor({ prefix: [] }),
      files: localFiles(tmpdir()),
      versions: { winstond: "0.1.0", cli: null },
      logger,
    });
    const socketPath = join(
      await mkdtemp(join(tmpdir(), "winstond-sock-")),
      "winstond.sock",
    );
    const server = await serveCliSocket(socketPath, (request) =>
      daemon.rpc(request),
    );
    running.push({ stop: () => void server.stop(true) });
    const response = await fetch("http://winstond/v1/me", { unix: socketPath });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "unavailable" },
    });
  });
});
