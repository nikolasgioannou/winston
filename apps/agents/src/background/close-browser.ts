/**
 * The `close_task_browser` job (docs/design.md §5, Browser): an ended run's
 * windows close and its sites free up at once, so no one is told a site is
 * "in use by task …" after that task is done.
 */
import { z } from "zod";
import { GatewayError, type VmClient } from "../vm/gateway-client.ts";
import type { JobHandler } from "../worker.ts";

export function closeTaskBrowserHandler(vm: VmClient): JobHandler {
  return async ({ job }) => {
    const { runId } = z.object({ runId: z.string() }).parse(job.payload);
    if (!job.userId) return;
    try {
      await vm.closeBrowser(job.userId, runId);
    } catch (error) {
      // No computer (never set up, or gone): there's nothing to close.
      if (error instanceof GatewayError && error.code === "not_found") return;
      throw error;
    }
  };
}
