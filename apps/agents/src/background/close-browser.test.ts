import { describe, expect, test } from "bun:test";
import type { Db } from "@winston/db/client";
import type { Job } from "@winston/db/queue";
import { createLogger } from "@winston/shared/logger";
import { GatewayError } from "../vm/gateway-client.ts";
import { fakeVmClient } from "../vm/testing.ts";
import { closeTaskBrowserHandler } from "./close-browser.ts";

const logger = createLogger("agents-test", {
  pretty: false,
  destination: { write: () => undefined },
});

const context = (payload: unknown) => ({
  job: { userId: "usr_1", payload } as Job,
  db: {} as Db,
  logger,
  extendLease: () => Promise.resolve(true),
});

describe("close_task_browser", () => {
  test("closes the ended run's windows on the user's computer", async () => {
    const closed: [string, string][] = [];
    const handler = closeTaskBrowserHandler({
      ...fakeVmClient().client,
      closeBrowser: (userId, owner) => {
        closed.push([userId, owner]);
        return Promise.resolve();
      },
    });
    await handler(context({ runId: "task_1" }));
    expect(closed).toEqual([["usr_1", "task_1"]]);
  });

  test("a user with no computer has nothing to close; a computer that's away is retried", async () => {
    const failing = (error: Error) =>
      closeTaskBrowserHandler({
        ...fakeVmClient().client,
        closeBrowser: () => Promise.reject(error),
      });
    await failing(new GatewayError("not_found", "No computer."))(
      context({ runId: "task_1" }),
    );
    const error = await failing(
      new GatewayError("vm_unavailable", "Not connected."),
    )(context({ runId: "task_1" })).catch((e: unknown) => e);
    expect((error as GatewayError).code).toBe("vm_unavailable");
  });
});
