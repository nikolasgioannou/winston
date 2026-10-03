/**
 * The `delegate` tool (docs/design.md §1, §5): the front of house hands a
 * longer job to a background agent and carries on. It returns as soon as the
 * task is queued, so the turn never waits for the work.
 */
import type { DbOrTx } from "@winston/db/client";
import { newId } from "@winston/db/ids";
import type { ToolDefinition } from "@winston/prompts";
import type { Logger } from "@winston/shared/logger";
import { tool } from "ai";
import { z } from "zod";
import { startBackgroundRun } from "../background/run.ts";
import type { VmClient } from "../vm/gateway-client.ts";

const inputSchema = z.object({
  brief: z
    .string()
    .min(1)
    .describe(
      "Everything the background agent needs, since it sees nothing of this conversation: the goal, the context and the user's relevant preferences (from your notes), constraints, what the user has approved (word for word), and what to report back.",
    ),
  effort: z
    .enum(["low", "medium", "high"])
    .default("high")
    .describe(
      "How hard it should think: high for most tasks, low for simple, mechanical ones.",
    ),
  window: z
    .string()
    .optional()
    .describe(
      "One of your browser windows (win_…) to hand to the agent, when it should carry on from that page (signed in, mid-flow, a form half filled): it gets the window as it is, with its session and history, and you can only look at it afterwards.",
    ),
});

/** Tells the task, in its brief, which window it was given. */
const windowNote = (window: { windowId: string; url: string }) =>
  `Your browser window ${window.windowId} was handed to you as it was, on ${window.url}: it's your current window, with the session and history, so carry on there (snapshot first) rather than opening a new one.`;

const description =
  "Start a background agent on a longer task and carry on talking: it works on its own computer session with the same tools as you, then reports back to you (not to the user) when it's done. The brief must be self-contained: the agent can't see this conversation or ask the user anything.";

export const delegateDefinition: ToolDefinition = {
  name: "delegate",
  description,
  inputSchema: z.toJSONSchema(inputSchema),
};

export function delegateTool(context: {
  db: DbOrTx;
  logger: Logger;
  /** The user's computer, to hand a window over. */
  vm: Pick<VmClient, "transferBrowser">;
  userId: string;
  /** The front-of-house turn delegating. */
  runId: string;
}) {
  return tool({
    description,
    inputSchema,
    execute: async ({ brief, effort, window }) => {
      // The window changes hands before the task's first step can run.
      const taskId = newId("task");
      let handed: { windowId: string; url: string } | null = null;
      if (window) {
        try {
          handed = await context.vm.transferBrowser(context.userId, {
            from: "front",
            to: taskId,
            windowId: window,
          });
        } catch (error) {
          context.logger.warn({ err: error }, "handing a window over failed");
          return `Not started: your computer couldn't hand over ${window} just now. Try again, or delegate without the window.`;
        }
        if (!handed)
          return `Not started: ${window} isn't a window of yours to hand over (or the user has it). winston browser windows lists yours.`;
      }
      await startBackgroundRun(context.db, {
        id: taskId,
        userId: context.userId,
        brief: handed ? `${brief}\n\n${windowNote(handed)}` : brief,
        effort,
        triggerType: "delegate",
        parentRunId: context.runId,
      });
      context.logger.info(
        { taskId, effort, window: handed?.windowId },
        "delegated a task",
      );
      const given = handed
        ? ` It has your window ${handed.windowId} now; you can look at it but not act in it.`
        : "";
      return `Started ${taskId}.${given} It runs in the background; its report comes back to you when it's done.`;
    },
  });
}
