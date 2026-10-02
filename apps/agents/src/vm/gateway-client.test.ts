import { afterAll, describe, expect, test } from "bun:test";
import { gatewayClient, vmRetry } from "./gateway-client.ts";

/** Two gateways, as during a deploy: only `holding` has the user's VM. */
const calls: string[] = [];
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
  fetch() {
    calls.push("holding");
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
      expect(stuck.exec("usr_1", request)).rejects.toMatchObject({
        code: "vm_unavailable",
      });
    } finally {
      vmRetry.forMs = saved;
    }
  });
});
