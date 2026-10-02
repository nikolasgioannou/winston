/**
 * The live view of a handed-over tab (docs/design.md §5 Browser handoff):
 * Chrome's screencast of that one target, sent as binary messages, and the
 * person's taps, scrolls and typing replayed into it as trusted input.
 *
 * Each live view has its own CDP session on the target, so it never touches
 * the agent's. A window in the background still paints (Chrome runs with
 * backgrounding off), and the page is told it has focus while it's watched,
 * so it behaves as if in front. The first frame is a screenshot: a
 * screencast only sends frames when something repaints.
 */
import {
  screencastMessage,
  type ViewerInput,
  type VmToGatewayFrame,
} from "@winston/domain/frames";
import type { Logger } from "@winston/shared/logger";
import type { Cdp, CdpEvent } from "./cdp.ts";
import { parseKey, press } from "./input.ts";

export const screencastSettings = {
  format: "jpeg",
  quality: 60,
  /** Big enough for a phone held either way; Chrome scales the tab down to fit. */
  maxWidth: 1280,
  maxHeight: 1600,
} as const;

interface Live {
  handoffId: string;
  targetId: string;
  sessionId: string;
  width: number;
  height: number;
  /** Whether a pointer is down (a drag sends moves with the button held). */
  pressed: boolean;
  stopListening: () => void;
}

export interface ScreencastDeps {
  connection: () => Promise<Cdp>;
  /** Sends a binary screencast message to the gateway. */
  sendBinary: (message: Uint8Array) => void;
  /** Sends a frame to the gateway (`screencast.ended`). */
  sendFrame: (frame: VmToGatewayFrame) => void;
  newFrameId: () => string;
  logger: Logger;
}

export function createScreencasts(deps: ScreencastDeps) {
  const live = new Map<string, Live>();

  function end(view: Live, reason: string) {
    if (live.get(view.handoffId) !== view) return;
    live.delete(view.handoffId);
    view.stopListening();
    deps.sendFrame({
      id: deps.newFrameId(),
      type: "screencast.ended",
      handoffId: view.handoffId,
      reason,
    });
  }

  function frameOut(view: Live, data: string, width: number, height: number) {
    view.width = width;
    view.height = height;
    deps.sendBinary(
      screencastMessage(
        { handoffId: view.handoffId, width, height },
        Buffer.from(data, "base64"),
      ),
    );
  }

  async function stop(handoffId: string) {
    const view = live.get(handoffId);
    if (!view) return;
    live.delete(handoffId);
    view.stopListening();
    const c = await deps.connection().catch(() => undefined);
    if (!c) return;
    await c
      .send("Page.stopScreencast", {}, view.sessionId)
      .catch(() => undefined);
    await c
      .send(
        "Emulation.setFocusEmulationEnabled",
        { enabled: false },
        view.sessionId,
      )
      .catch(() => undefined);
    await c
      .send("Target.detachFromTarget", { sessionId: view.sessionId })
      .catch(() => undefined);
  }

  return {
    async start(handoffId: string, targetId: string) {
      await stop(handoffId);
      const c = await deps.connection();
      let sessionId: string;
      try {
        ({ sessionId } = await c.send<{ sessionId: string }>(
          "Target.attachToTarget",
          { targetId, flatten: true },
        ));
      } catch {
        deps.sendFrame({
          id: deps.newFrameId(),
          type: "screencast.ended",
          handoffId,
          reason: "That window is gone.",
        });
        return;
      }
      const view: Live = {
        handoffId,
        targetId,
        sessionId,
        width: 0,
        height: 0,
        pressed: false,
        stopListening: () => undefined,
      };
      view.stopListening = c.on((event: CdpEvent) => {
        if (
          event.method === "Page.screencastFrame" &&
          event.sessionId === sessionId
        ) {
          const params = event.params as {
            data: string;
            sessionId: number;
            metadata: { deviceWidth: number; deviceHeight: number };
          };
          // Chrome sends the next frame only once this one is acknowledged.
          void c
            .send(
              "Page.screencastFrameAck",
              { sessionId: params.sessionId },
              sessionId,
            )
            .catch(() => undefined);
          frameOut(
            view,
            params.data,
            params.metadata.deviceWidth,
            params.metadata.deviceHeight,
          );
          return;
        }
        if (
          (event.method === "Target.targetDestroyed" &&
            event.params.targetId === targetId) ||
          (event.method === "Target.detachedFromTarget" &&
            event.params.sessionId === sessionId)
        )
          end(view, "The window was closed.");
      });
      live.set(handoffId, view);
      await c.send("Page.enable", {}, sessionId);
      // Watched means in front: focus, as for a window the person clicked into.
      await c
        .send(
          "Emulation.setFocusEmulationEnabled",
          { enabled: true },
          sessionId,
        )
        .catch(() => undefined);
      await c.send("Page.bringToFront", {}, sessionId).catch(() => undefined);
      const metrics = await c.send<{
        cssVisualViewport: { clientWidth: number; clientHeight: number };
      }>("Page.getLayoutMetrics", {}, sessionId);
      const first = await c
        .send<{ data: string }>(
          "Page.captureScreenshot",
          { format: "jpeg", quality: screencastSettings.quality },
          sessionId,
        )
        .catch(() => undefined);
      if (first && live.get(handoffId) === view)
        frameOut(
          view,
          first.data,
          metrics.cssVisualViewport.clientWidth,
          metrics.cssVisualViewport.clientHeight,
        );
      await c.send(
        "Page.startScreencast",
        { ...screencastSettings, everyNthFrame: 1 },
        sessionId,
      );
      deps.logger.info({ handoffId, targetId }, "live view started");
    },

    stop,

    /** Replays what the person did on the live view into the tab. */
    async input(handoffId: string, input: ViewerInput) {
      const view = live.get(handoffId);
      if (!view) return;
      const c = await deps.connection();
      const s = view.sessionId;
      switch (input.kind) {
        case "pointer": {
          const at = { x: input.x, y: input.y };
          if (input.action === "down") {
            await c.send(
              "Input.dispatchMouseEvent",
              { type: "mouseMoved", ...at },
              s,
            );
            await c.send(
              "Input.dispatchMouseEvent",
              {
                type: "mousePressed",
                ...at,
                button: "left",
                buttons: 1,
                clickCount: 1,
              },
              s,
            );
            view.pressed = true;
          } else if (input.action === "move") {
            await c.send(
              "Input.dispatchMouseEvent",
              {
                type: "mouseMoved",
                ...at,
                ...(view.pressed ? { button: "left", buttons: 1 } : {}),
              },
              s,
            );
          } else {
            await c.send(
              "Input.dispatchMouseEvent",
              {
                type: "mouseReleased",
                ...at,
                button: "left",
                buttons: 0,
                clickCount: 1,
              },
              s,
            );
            view.pressed = false;
          }
          return;
        }
        case "wheel":
          await c.send(
            "Input.dispatchMouseEvent",
            {
              type: "mouseWheel",
              x: input.x,
              y: input.y,
              deltaX: input.deltaX,
              deltaY: input.deltaY,
            },
            s,
          );
          return;
        case "key": {
          const key = parseKey(input.key);
          if (key) await press(c, s, key);
          return;
        }
        case "text":
          await c.send("Input.insertText", { text: input.text }, s);
          return;
      }
    },

    /** Ends every live view (Chrome went away). */
    endAll(reason: string) {
      for (const view of [...live.values()]) end(view, reason);
    },
  };
}

export type Screencasts = ReturnType<typeof createScreencasts>;
