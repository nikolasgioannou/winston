import { afterAll, describe, expect, test } from "bun:test";
import { gatewayClient, vmRetry } from "./gateway-client.ts";

/** Two gateways, as during a deploy: only `holding` has the user's VM. */
const calls: string[] = [];
/** The exec ids `holding` was sent, in order. */
const ids: unknown[] = [];
let awayFor = 0;
const result = {
  stdout: "ok",
  stderr: "",
  exitCode: 0,
  timedOut: false,
  truncated: false,
};
const holding = Bun.serve({
  port: 0,
  async fetch(req) {
    calls.push("holding");
    ids.push(((await req.json()) as { id?: unknown }).id);
    // The VM is reconnecting for the first `awayFor` calls (winstond restarting).
    if (awayFor > 0) {
      awayFor -= 1;
      return Response.json(
        { error: { code: "vm_unavailable", message: "away" } },
        { status: 409 },
      );
    }
    return Response.json(result);
  },
});
const other = Bun.serve({
  port: 0,
  fetch() {
    calls.push("other");
    return Response.json(
      {
        error: {
          code: "vm_unavailable",
          message: "The user's computer isn't connected.",
        },
      },
      { status: 409 },
    );
  },
});
afterAll(async () => {
  await holding.stop(true);
  await other.stop(true);
});

const request = { cmd: "echo hi", env: {}, timeoutMs: 1000 };

describe("the gateway client", () => {
  test("a VM's calls go to the gateway holding it, not whichever answers the shared name", async () => {
    calls.length = 0;
    const client = gatewayClient({
      baseUrl: other.url.href,
      secret: "s",
      locate: () => Promise.resolve(holding.url.href),
      sleep: () => Promise.resolve(),
    });
    expect(await client.exec("usr_1", request)).toEqual(result);
    expect(calls).toEqual(["holding"]);
  });

  test("a VM that's away for a moment is retried; one that stays away fails after a while", async () => {
    calls.length = 0;
    awayFor = 2;
    const client = gatewayClient({
      baseUrl: other.url.href,
      secret: "s",
      locate: () => Promise.resolve(holding.url.href),
      sleep: () => Promise.resolve(),
    });
    expect(await client.exec("usr_1", request)).toEqual(result);
    expect(calls).toEqual(["holding", "holding", "holding"]);

    const saved = vmRetry.forMs;
    vmRetry.forMs = 30;
    try {
      const stuck = gatewayClient({
        baseUrl: other.url.href,
        secret: "s",
        sleep: () => Bun.sleep(10),
      });
      const error = await stuck.exec("usr_1", request).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "vm_unavailable" });
    } finally {
      vmRetry.forMs = saved;
    }
  });

  test("an exec without an id gets one, and its retries carry the same one", async () => {
    ids.length = 0;
    awayFor = 2;
    const client = gatewayClient({
      baseUrl: other.url.href,
      secret: "s",
      locate: () => Promise.resolve(holding.url.href),
      sleep: () => Promise.resolve(),
    });
    await client.exec("usr_1", request);
    expect(ids).toHaveLength(3);
    expect(typeof ids[0]).toBe("string");
    expect(new Set(ids).size).toBe(1);
    await client.exec("usr_1", { ...request, id: "x_mine" });
    expect(ids.at(-1)).toBe("x_mine");
  });

  test("the retry window starts at the first failure, so a long command cut off late still gets it", async () => {
    awayFor = 1;
    const saved = vmRetry.forMs;
    vmRetry.forMs = 50;
    let clock = 0;
    const realNow = Date.now;
    // The first answer comes after the window would have closed, counted from the start.
    Date.now = () => realNow() + clock;
    try {
      const client = gatewayClient({
        baseUrl: other.url.href,
        secret: "s",
        locate: () => {
          clock += 1_000;
          return Promise.resolve(holding.url.href);
        },
        sleep: () => Promise.resolve(),
      });
      expect(await client.exec("usr_1", request)).toEqual(result);
    } finally {
      Date.now = realNow;
      vmRetry.forMs = saved;
    }
  });
});
