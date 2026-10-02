import { describe, expect, test } from "bun:test";
import {
  desktopMessage,
  gatewayToVmFrame,
  parseDesktopMessage,
  parseFrame,
  parseScreencastMessage,
  screencastMessage,
  vmToGatewayFrame,
} from "./frames.ts";

describe("frames", () => {
  test("parses a valid hello", () => {
    const parsed = parseFrame(
      vmToGatewayFrame,
      JSON.stringify({
        id: "1",
        type: "hello",
        cliVersion: "0.1.0",
        winstondVersion: "0.1.0",
        capabilities: [],
      }),
    );
    expect(parsed).toEqual({
      ok: true,
      frame: {
        id: "1",
        type: "hello",
        cliVersion: "0.1.0",
        winstondVersion: "0.1.0",
        capabilities: [],
      },
    });
  });

  test("rejects malformed frames with a reason", () => {
    for (const text of [
      "not json",
      JSON.stringify({ type: "hello" }),
      JSON.stringify({ id: "1", type: "unknown" }),
      JSON.stringify({ id: "1", type: "pong" }),
      JSON.stringify({ id: "", type: "ping" }),
    ]) {
      const parsed = parseFrame(vmToGatewayFrame, text);
      expect(parsed.ok).toBe(false);
    }
  });

  test("direction matters: a VM can't send a registered frame", () => {
    const text = JSON.stringify({ id: "1", type: "registered", vmToken: "t" });
    expect(parseFrame(vmToGatewayFrame, text).ok).toBe(false);
    expect(parseFrame(gatewayToVmFrame, text).ok).toBe(true);
  });

  test("desktop bytes round-trip intact, and neither binary kind passes for the other", () => {
    const bytes = new Uint8Array([0, 10, 255, 82, 70, 66, 10]);
    const message = desktopMessage("hnd_1", bytes);
    const parsed = parseDesktopMessage(message);
    expect(parsed?.handoffId).toBe("hnd_1");
    expect([...(parsed?.bytes ?? [])]).toEqual([...bytes]);
    expect(parseScreencastMessage(message)).toBeUndefined();
    const frame = screencastMessage(
      { handoffId: "hnd_1", width: 10, height: 10 },
      new Uint8Array([0xff, 0xd8]),
    );
    expect(parseDesktopMessage(frame)).toBeUndefined();
  });
});
