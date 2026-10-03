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

/** A window showing nothing, so there'd be nothing for the user to take over. */
export const isBlankPage = (url: string) =>
  url === "" ||
  url === "about:blank" ||
  url.startsWith("chrome://newtab") ||
  url.startsWith("chrome-error://");

/** What the agent hears when its window is blank: the handoff is refused, and it carries on. */
export const blankWindowNote =
  "Not handed over: your browser window is blank, so the user would see an empty screen. Open the page they need first (winston browser open <url>), then hand it over. If their part isn't in the browser, close the blank window (winston browser close) and hand over again.";

/** The message that carries the front of house's handoff link. */
export const handoffLinkMessage = (link: string) =>
  `Over to you in the browser: ${link}\n(Tap Done there, or tell me, when you're finished.)`;

/**
 * For the front of house: the call ends the turn, and it has an `execute` so
 * the call and its result are both stored (the next turn needs both).
 */
export function frontHandoffTool(deps: {
  hold: () => Promise<{
    windowId: string;
    targetId: string;
    url: string;
  } | null>;
  /** Lets the held window go again (it was blank). */
  release: () => Promise<unknown>;
  createLink: (
    window: { windowId: string; targetId: string },
    reason: string,
  ) => Promise<string>;
  sendLink: (text: string) => Promise<unknown>;
  /** The handoff went through, so the turn ends. */
  handedOver: () => void;
  logger: Logger;
}) {
  return tool({
    description,
    inputSchema,
    execute: async ({ reason }) => {
      const ends =
        "Your turn ends here; the user's reply comes as their next message.";
      let window: Awaited<ReturnType<typeof deps.hold>> = null;
      try {
        window = await deps.hold();
      } catch (error) {
        deps.logger.warn(
          { err: error },
          "holding the browser for a handoff failed",
        );
      }
      if (window && isBlankPage(window.url)) {
        await deps.release().catch((error: unknown) => {
          deps.logger.warn({ err: error }, "letting a blank window go failed");
        });
        return blankWindowNote;
      }
      deps.handedOver();
      if (!window)
        return `Handed over, without a live view (you have no browser window). ${ends}`;
      await deps.sendLink(
        handoffLinkMessage(await deps.createLink(window, reason)),
      );
      return `Handed over: the user was sent a link to your window on their browser page. ${ends}`;
    },
  });
}
