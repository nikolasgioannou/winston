import { describe, expect, test } from "bun:test";
import { createLogger } from "@winston/shared/logger";
import { frontHandoffTool, handoffLinkMessage } from "./handoff.ts";

const logger = createLogger("agents-test", {
  pretty: false,
  destination: { write: () => undefined },
});

const run = async (tool: ReturnType<typeof frontHandoffTool>) =>
  tool.execute(
    { reason: "Sign in to OpenTable." },
    { toolCallId: "c1", messages: [], context: {} },
  );

describe("the front of house's handoff", () => {
  test("with a browser window, the user is sent a live-view link straight away", async () => {
    const sent: string[] = [];
    const result = await run(
      frontHandoffTool({
        hold: () => Promise.resolve({ windowId: "win_1", targetId: "T1" }),
        createLink: (window, reason) =>
          Promise.resolve(
            `https://runwinston.com/t/tok-${window.windowId}-${String(reason.length)}`,
          ),
        sendLink: (text) => {
          sent.push(text);
          return Promise.resolve();
        },
        logger,
      }),
    );
    expect(sent).toEqual([
      handoffLinkMessage("https://runwinston.com/t/tok-win_1-21"),
    ]);
    expect(result).toStartWith(
      "Handed over: the user was sent a live-view link",
    );
  });

  test("without one (or the computer can't say), it still hands over, with no link", async () => {
    const sent: string[] = [];
    for (const hold of [
      () => Promise.resolve(null),
      () => Promise.reject(new Error("vm unreachable")),
    ]) {
      const result = await run(
        frontHandoffTool({
          hold,
          createLink: () => Promise.resolve("never"),
          sendLink: (text) => {
            sent.push(text);
            return Promise.resolve();
          },
          logger,
        }),
      );
      expect(result).toStartWith("Handed over, without a live view");
    }
    expect(sent).toEqual([]);
  });
});
