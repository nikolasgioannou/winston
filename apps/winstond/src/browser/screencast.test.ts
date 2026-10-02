import { describe, expect, test } from "bun:test";
import {
  parseScreencastMessage,
  type VmToGatewayFrame,
} from "@winston/domain/frames";
import { createLogger } from "@winston/shared/logger";
import type { Cdp, CdpEvent } from "./cdp.ts";
import { createScreencasts } from "./screencast.ts";

const logger = createLogger("winstond-test", {
  pretty: false,
  destination: { write: () => undefined },
});

function fakeChrome() {
  const listeners = new Set<(event: CdpEvent) => void>();
  const sent: {
    method: string;
    params: Record<string, unknown>;
    sessionId?: string;
  }[] = [];
  const cdp: Cdp = {
    send<T>(
      method: string,
      params: Record<string, unknown> = {},
      sessionId?: string,
    ) {
      sent.push({ method, params, ...(sessionId ? { sessionId } : {}) });
      const answer = (value: unknown) => Promise.resolve(value as T);
      if (method === "Target.attachToTarget")
        return answer({ sessionId: "live-1" });
      if (method === "Page.getLayoutMetrics")
        return answer({
          cssVisualViewport: { clientWidth: 1919, clientHeight: 992 },
        });
      if (method === "Page.captureScreenshot")
        return answer({ data: Buffer.from("first").toString("base64") });
      return answer({});
    },
    on(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    closed: new Promise(() => undefined),
    close: () => undefined,
  };
  return {
    cdp,
    sent,
    emit: (event: CdpEvent) => {
      for (const listener of listeners) listener(event);
    },
  };
}

function setup() {
  const chrome = fakeChrome();
  const binaries: Uint8Array[] = [];
  const frames: VmToGatewayFrame[] = [];
  let n = 0;
  const screencasts = createScreencasts({
    connection: () => Promise.resolve(chrome.cdp),
    sendBinary: (message) => binaries.push(message),
    sendFrame: (frame) => frames.push(frame),
    newFrameId: () => `f${String((n += 1))}`,
    logger,
  });
  return { chrome, binaries, frames, screencasts };
}

describe("live views", () => {
  test("a live view streams its own session of the target, first frame included, acknowledging each frame", async () => {
    const { chrome, binaries, screencasts } = setup();
    await screencasts.start("hnd_1", "TARGET1");
    expect(
      chrome.sent.find((s) => s.method === "Target.attachToTarget")?.params,
    ).toEqual({
      targetId: "TARGET1",
      flatten: true,
    });
    expect(
      chrome.sent.some(
        (s) =>
          s.method === "Emulation.setFocusEmulationEnabled" &&
          s.params.enabled === true,
      ),
    ).toBe(true);
    const first = parseScreencastMessage(binaries[0] ?? new Uint8Array());
    expect(first?.header).toEqual({
      handoffId: "hnd_1",
      width: 1919,
      height: 992,
    });
    expect(Buffer.from(first?.jpeg ?? []).toString()).toBe("first");
    chrome.emit({
      method: "Page.screencastFrame",
      sessionId: "live-1",
      params: {
        data: Buffer.from("next").toString("base64"),
        sessionId: 7,
        metadata: { deviceWidth: 1280, deviceHeight: 661 },
      },
    });
    // Another session's frames (the agent's) aren't this live view's.
    chrome.emit({
      method: "Page.screencastFrame",
      sessionId: "agent",
      params: {
        data: "",
        sessionId: 8,
        metadata: { deviceWidth: 1, deviceHeight: 1 },
      },
    });
    expect(binaries).toHaveLength(2);
    expect(
      parseScreencastMessage(binaries[1] ?? new Uint8Array())?.header.width,
    ).toBe(1280);
    await Bun.sleep(1);
    expect(
      chrome.sent.find((s) => s.method === "Page.screencastFrameAck")?.params,
    ).toEqual({ sessionId: 7 });
  });

  test("taps, drags, keys and typed text become trusted input in that tab", async () => {
    const { chrome, screencasts } = setup();
    await screencasts.start("hnd_1", "TARGET1");
    const mark = chrome.sent.length;
    await screencasts.input("hnd_1", {
      kind: "pointer",
      action: "down",
      x: 10,
      y: 20,
    });
    await screencasts.input("hnd_1", {
      kind: "pointer",
      action: "move",
      x: 15,
      y: 25,
    });
    await screencasts.input("hnd_1", {
      kind: "pointer",
      action: "up",
      x: 15,
      y: 25,
    });
    await screencasts.input("hnd_1", { kind: "text", text: "123456" });
    await screencasts.input("hnd_1", { kind: "key", key: "Enter" });
    const input = chrome.sent
      .slice(mark)
      .map((s) => [s.method, s.params.type, s.sessionId]);
    expect(input).toEqual([
      ["Input.dispatchMouseEvent", "mouseMoved", "live-1"],
      ["Input.dispatchMouseEvent", "mousePressed", "live-1"],
      ["Input.dispatchMouseEvent", "mouseMoved", "live-1"],
      ["Input.dispatchMouseEvent", "mouseReleased", "live-1"],
      ["Input.insertText", undefined, "live-1"],
      ["Input.dispatchKeyEvent", "keyDown", "live-1"],
      ["Input.dispatchKeyEvent", "keyUp", "live-1"],
    ]);
    // A drag holds the button down while moving.
    expect(chrome.sent[mark + 2]?.params).toMatchObject({ buttons: 1 });
  });

  test("the tab closing ends the live view; stopping detaches without touching the agent", async () => {
    const { chrome, frames, screencasts } = setup();
    await screencasts.start("hnd_1", "TARGET1");
    chrome.emit({
      method: "Target.targetDestroyed",
      params: { targetId: "TARGET1" },
    });
    expect(frames).toEqual([
      {
        id: "f1",
        type: "screencast.ended",
        handoffId: "hnd_1",
        reason: "The window was closed.",
      },
    ]);
    await screencasts.start("hnd_2", "TARGET2");
    await screencasts.stop("hnd_2");
    expect(chrome.sent.at(-1)).toEqual({
      method: "Target.detachFromTarget",
      params: { sessionId: "live-1" },
    });
  });
});
