import { describe, expect, test } from "bun:test";
import { createLogger } from "@winston/shared/logger";
import {
  blankWindowNote,
  frontHandoffTool,
  handoffLinkMessage,
} from "./handoff.ts";

const logger = createLogger("agents-test", {
  pretty: false,
  destination: { write: () => undefined },
});

const run = async (tool: ReturnType<typeof frontHandoffTool>) =>
  tool.execute(
    { reason: "Sign in to OpenTable." },
    { toolCallId: "c1", messages: [], context: {} },
  );

/** A handoff over `hold`, recording links sent, releases and whether it went through. */
function handoff(hold: Parameters<typeof frontHandoffTool>[0]["hold"]) {
  const record = { sent: [] as string[], released: 0, handedOver: false };
  const tool = frontHandoffTool({
    hold,
    release: () => {
      record.released += 1;
      return Promise.resolve();
    },
    createLink: (window) =>
      Promise.resolve(
        `https://runwinston.com/browser?window=${window.windowId}`,
      ),
    sendLink: (text) => {
      record.sent.push(text);
      return Promise.resolve();
    },
    handedOver: () => {
      record.handedOver = true;
    },
    logger,
  });
  return { tool, record };
}

describe("the front of house's handoff", () => {
  test("with a browser window, the user is sent a link to it straight away", async () => {
    const { tool, record } = handoff(() =>
      Promise.resolve({
        windowId: "win_1",
        targetId: "T1",
        url: "https://www.opentable.com/",
      }),
    );
    const result = await run(tool);
    expect(record.sent).toEqual([
      handoffLinkMessage("https://runwinston.com/browser?window=win_1"),
    ]);
    expect(result).toStartWith("Handed over: the user was sent a link");
    expect(record.handedOver).toBe(true);
  });

  test("without one (or the computer can't say), it still hands over, with no link", async () => {
    for (const hold of [
      () => Promise.resolve(null),
      () => Promise.reject(new Error("vm unreachable")),
    ]) {
      const { tool, record } = handoff(hold);
      expect(await run(tool)).toStartWith("Handed over, without a live view");
      expect(record.sent).toEqual([]);
      expect(record.handedOver).toBe(true);
    }
  });

  test("a blank window isn't handed over: it's let go, and the turn carries on", async () => {
    for (const url of ["about:blank", "chrome-error://chromewebdata/"]) {
      const { tool, record } = handoff(() =>
        Promise.resolve({ windowId: "win_1", targetId: "T1", url }),
      );
      expect(await run(tool)).toBe(blankWindowNote);
      expect(record).toEqual({ sent: [], released: 1, handedOver: false });
    }
  });
});
