import { describe, expect, test } from "bun:test";
import type { DockerEngine } from "./docker-engine.ts";
import { dockerVmProvider } from "./docker-provider.ts";

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

/** An Engine API stub: answers each call from `responses` (matched by path prefix) and records it. */
function stubEngine(responses: [string, { status: number; body?: unknown }][]) {
  const calls: Call[] = [];
  const pending = [...responses];
  const engine: DockerEngine = {
    request: (method, path, body) => {
      calls.push({ method, path, body });
      const index = pending.findIndex(([prefix]) =>
        `${method} ${path}`.startsWith(prefix),
      );
      const [, response] =
        index >= 0
          ? (pending.splice(index, 1)[0] ?? ["", { status: 500 }])
          : ["", { status: 500 }];
      return Promise.resolve({ status: response.status, body: response.body });
    },
  };
  return { engine, calls };
}

const options = {
  image: "winston-vm:local",
  gatewayUrl: "ws://host.docker.internal:3001",
};

describe("dockerVmProvider", () => {
  test("create makes the data volume and a container with the spike's flags, token and gateway", async () => {
    const { engine, calls } = stubEngine([
      ["POST /volumes/create", { status: 201, body: {} }],
      ["POST /containers/create", { status: 201, body: { Id: "abc123" } }],
      [
        "GET /images/winston-vm%3Alocal/json",
        { status: 200, body: { Id: "sha256:img1" } },
      ],
    ]);
    const provider = dockerVmProvider({ engine, ...options });
    expect(
      await provider.create({ userId: "usr_1", registrationToken: "tok" }),
    ).toEqual({
      instanceId: "abc123",
      dataVolumeId: "winston-home-usr_1",
      // The image it was built from, so a rebuilt image rolls it.
      imageId: "sha256:img1",
    });
    expect(calls[0]).toMatchObject({
      path: "/volumes/create",
      body: { Name: "winston-home-usr_1" },
    });
    expect(calls[1]?.path).toBe("/containers/create?name=winston-vm-usr_1");
    expect(calls[1]?.body).toMatchObject({
      Image: "winston-vm:local",
      Env: [
        "WINSTON_REGISTRATION_TOKEN=tok",
        "WINSTON_GATEWAY_URL=ws://host.docker.internal:3001",
      ],
      HostConfig: {
        CgroupnsMode: "host",
        Binds: [
          "/sys/fs/cgroup:/sys/fs/cgroup:rw",
          "winston-home-usr_1:/home/winston",
        ],
        Tmpfs: { "/run": "", "/run/lock": "" },
        ShmSize: 1024 * 1024 * 1024,
        SecurityOpt: ["seccomp=unconfined"],
      },
    });
  });

  test("a container left from an earlier attempt is replaced", async () => {
    const { engine, calls } = stubEngine([
      ["POST /volumes/create", { status: 200, body: {} }],
      [
        "POST /containers/create",
        { status: 409, body: { message: "name in use" } },
      ],
      ["DELETE /containers/winston-vm-usr_1", { status: 204 }],
      ["POST /containers/create", { status: 201, body: { Id: "new" } }],
    ]);
    const provider = dockerVmProvider({ engine, ...options });
    const { instanceId } = await provider.create({
      userId: "usr_1",
      registrationToken: "tok",
    });
    expect(instanceId).toBe("new");
    expect(calls.map((call) => `${call.method} ${call.path}`)).toContain(
      "DELETE /containers/winston-vm-usr_1?force=true",
    );
  });

  test("start and stop accept 'already' answers; unexpected ones throw", async () => {
    const { engine } = stubEngine([
      ["POST /containers/x/start", { status: 304 }],
      ["POST /containers/x/stop", { status: 304 }],
      ["POST /containers/x/start", { status: 500, body: { message: "boom" } }],
    ]);
    const provider = dockerVmProvider({ engine, ...options });
    await provider.start("x");
    await provider.stop("x");
    const error = await provider.start("x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("boom");
  });

  test("status maps Docker's states", async () => {
    const answers = {
      running: "running",
      restarting: "starting",
      exited: "stopped",
      created: "stopped",
    } as const;
    for (const [dockerState, expected] of Object.entries(answers)) {
      const { engine } = stubEngine([
        [
          "GET /containers/x/json",
          { status: 200, body: { State: { Status: dockerState } } },
        ],
      ]);
      expect(await dockerVmProvider({ engine, ...options }).status("x")).toBe(
        expected,
      );
    }
    const { engine } = stubEngine([
      ["GET /containers/x/json", { status: 404 }],
    ]);
    expect(await dockerVmProvider({ engine, ...options }).status("x")).toBe(
      "gone",
    );
  });
});
