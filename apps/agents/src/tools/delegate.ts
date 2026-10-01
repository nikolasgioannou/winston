/**
 * The `delegate` tool (docs/design.md §1, §5): the front of house hands a
 * longer job to a background agent and carries on. It returns as soon as the
 * task is queued, so the turn never waits for the work.
 */
import type { DbOrTx } from "@winston/db/client";
import type { ToolDefinition } from "@winston/prompts";
import type { Logger } from "@winston/shared/logger";
import { tool } from "ai";
import { z } from "zod";
import { startBackgroundRun } from "../background/run.ts";

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
});

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
  userId: string;
  /** The front-of-house turn delegating. */
  runId: string;
}) {
  return tool({
    description,
    inputSchema,
    execute: async ({ brief, effort }) => {
      const taskId = await startBackgroundRun(context.db, {
        userId: context.userId,
        brief,
        effort,
        triggerType: "delegate",
        parentRunId: context.runId,
      });
      context.logger.info({ taskId, effort }, "delegated a task");
      return `Started ${taskId}. It runs in the background; its report comes back to you when it's done.`;
    },
  });
}
