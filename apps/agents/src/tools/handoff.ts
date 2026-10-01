/**
 * The `browser_handoff` tool (docs/design.md §1, Browser handoff; §5): the
 * agent hands over to the user for something only they can do, and stops.
 * A background run parks until `task resume`; a front-of-house turn simply
 * ends, and the user's reply arrives as the next message. The live-view link
 * comes with the browser (M8).
 */
import { handoffTool } from "@winston/db/tasks";
import type { ToolDefinition } from "@winston/prompts";
import { tool } from "ai";
import { z } from "zod";

const inputSchema = z.object({
  reason: z
    .string()
    .min(1)
    .describe(
      'What the user needs to do, plainly, e.g. "Sign in to OpenTable; it\'s asking for a code sent to your phone."',
    ),
});

const description =
  "Hand the browser over to the user when only they can do the next part: signing in, a code sent to their phone, a CAPTCHA, a payment or verification step. Say what they need to do. You stop here, and continue once they're done.";

export const browserHandoffDefinition: ToolDefinition = {
  name: handoffTool,
  description,
  inputSchema: z.toJSONSchema(inputSchema),
};

/** For background runs: no `execute`, so calling it ends the step and the run parks. */
export const backgroundHandoffTool = tool({
  description,
  inputSchema,
  outputSchema: z.string(),
});

/**
 * For the front of house: the call ends the turn, and it has an `execute` so
 * the call and its result are both stored (the next turn needs both).
 */
export const frontHandoffTool = tool({
  description,
  inputSchema,
  execute: () =>
    Promise.resolve(
      "Handed over. Your turn ends here; the user's reply comes as their next message.",
    ),
});
