/**
 * The `browser_handoff` tool (docs/design.md §1, Browser handoff; §5): the
 * agent hands over to the user for something only they can do, and stops.
 * A background run parks until `task resume`; a front-of-house turn simply
 * ends, and the user's reply arrives as the next message.
 *
 * When the agent has a browser window, it's held for the user (the agent
 * can't act in it) and a live-view link is made: a background run's goes in
 * its `task.needs_user` item; the front of house's is sent to the user right
 * away, since the turn ends with the call.
 */
import type { Logger } from "@winston/shared/logger";
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

/** The message that carries the front of house's handoff link. */
export const handoffLinkMessage = (link: string) =>
  `Here's the browser, to take over: ${link}\n(The link works once, for 15 minutes. Tell me when you're done.)`;

/**
 * For the front of house: the call ends the turn, and it has an `execute` so
 * the call and its result are both stored (the next turn needs both).
 */
export function frontHandoffTool(deps: {
  hold: () => Promise<{ windowId: string; targetId: string } | null>;
  createLink: (
    window: { windowId: string; targetId: string },
    reason: string,
  ) => Promise<string>;
  sendLink: (text: string) => Promise<unknown>;
  logger: Logger;
}) {
  return tool({
    description,
    inputSchema,
    execute: async ({ reason }) => {
      const ends =
        "Your turn ends here; the user's reply comes as their next message.";
      let window: { windowId: string; targetId: string } | null = null;
      try {
        window = await deps.hold();
      } catch (error) {
        deps.logger.warn(
          { err: error },
          "holding the browser for a handoff failed",
        );
      }
      if (!window)
        return `Handed over, without a live view (you have no browser window). ${ends}`;
      await deps.sendLink(
        handoffLinkMessage(await deps.createLink(window, reason)),
      );
      return `Handed over: the user was sent a live-view link to your browser window. ${ends}`;
    },
  });
}
