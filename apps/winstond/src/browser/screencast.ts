/**
 * The live view of a handed-over tab (docs/design.md §5 Browser handoff):
 * Chrome's screencast of that one target, sent as binary messages, and the
 * person's taps, scrolls and typing replayed into it as trusted input.
 *
 * Each live view has its own CDP session on the target, so it never touches
 * the agent's. A window in the background still paints (Chrome runs with
 * backgrounding off), and the page is told it has focus while it's watched,
 * so it behaves as if in front. The first frame is a screenshot: a
 * screencast only sends frames when something repaints. The page sends its
 * size, and the tab is shown at that size (a phone gets the site's mobile
 * layout, not a desktop shrunk to nothing).
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
  viewId: string;
  targetId: string;
  sessionId: string;
  width: number;
  height: number;
  /** Whether a pointer is down (a drag sends moves with the button held). */
  pressed: boolean;
  /**
   * Input replays one at a time, in order: a tap's press takes two CDP
   * calls, and its release mustn't overtake them (no click happens then).
   */
  queue: Promise<void>;
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
    if (live.get(view.viewId) !== view) return;
    live.delete(view.viewId);
    view.stopListening();
    deps.sendFrame({
      id: deps.newFrameId(),
      type: "screencast.ended",
      viewId: view.viewId,
      reason,
    });
  }

  function frameOut(view: Live, data: string, width: number, height: number) {
    view.width = width;
    view.height = height;
    deps.sendBinary(
      screencastMessage(
        { viewId: view.viewId, width, height },
        Buffer.from(data, "base64"),
      ),
    );
  }

  async function stop(viewId: string) {
    const view = live.get(viewId);
    if (!view) return;
    live.delete(viewId);
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
    async start(viewId: string, targetId: string) {
      await stop(viewId);
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
          viewId,
          reason: "That window is gone.",
        });
        return;
      }
      const view: Live = {
        viewId,
        targetId,
        sessionId,
        width: 0,
        height: 0,
        pressed: false,
        queue: Promise.resolve(),
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
      live.set(viewId, view);
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
      if (first && live.get(viewId) === view)
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
      deps.logger.info({ viewId, targetId }, "live view started");
    },

    stop,

    /** Replays what the person did on the live view into the tab, in order. */
    input(viewId: string, input: ViewerInput) {
      const view = live.get(viewId);
      if (!view) return Promise.resolve();
      const next = view.queue.then(() => replay(view, input));
      // One failed input doesn't stop the ones after it.
      view.queue = next.catch(() => undefined);
      return next;
    },

    /** Ends every live view (Chrome went away). */
    endAll(reason: string) {
      for (const view of [...live.values()]) end(view, reason);
    },
  };

  async function replay(view: Live, input: ViewerInput) {
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
      case "viewport":
        // Only this live view's session sees it; when it detaches the tab
        // is back at its own size for the agent.
        await c.send(
          "Emulation.setDeviceMetricsOverride",
          {
            width: input.width,
            height: input.height,
            deviceScaleFactor: Math.min(input.scale, 3),
            mobile: input.width < 900,
          },
          s,
        );
        return;
    }
  }
}

export type Screencasts = ReturnType<typeof createScreencasts>;
