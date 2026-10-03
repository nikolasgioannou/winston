/**
 * The gateway's browser frames (docs/design.md §5, §15): hold a run's
 * window for the user, let it go, close an ended run's windows, give a
 * window to another run, and run a tab's live view.
 */
import {
  newFrameId,
  parseDesktopMessage,
  type VmToGatewayFrame,
} from "@winston/domain/frames";
import type { Logger } from "@winston/shared/logger";
import type { BrowserFrame } from "../daemon.ts";
import type { Desktops } from "./desktop.ts";
import type { Screencasts } from "./screencast.ts";
import type { Browser } from "./windows.ts";

export function handoffFrames({
  browser,
  screencasts,
  desktops,
  sendFrame,
  logger,
}: {
  browser: Pick<Browser, "hold" | "release" | "transfer" | "closeOwner">;
  screencasts: Screencasts;
  desktops: Pick<Desktops, "open" | "write" | "close" | "closeAll">;
  /** Sends on the live connection (a live view can end any time). */
  sendFrame: (frame: VmToGatewayFrame) => void;
  logger: Logger;
}) {
  return {
    handle(frame: BrowserFrame, reply: (frame: VmToGatewayFrame) => void) {
      switch (frame.type) {
        case "browser.hold":
          reply({
            id: newFrameId(),
            type: "browser.held",
            replyTo: frame.id,
            window: browser.hold(frame.owner),
          });
          return;
        case "browser.release":
          if (frame.close)
            browser.closeOwner(frame.owner).catch((error: unknown) => {
              logger.warn(
                { err: error, owner: frame.owner },
                "closing an ended run's windows failed",
              );
            });
          else browser.release(frame.owner);
          return;
        case "browser.transfer":
          reply({
            id: newFrameId(),
            type: "browser.transferred",
            replyTo: frame.id,
            window: browser.transfer(frame.from, frame.to, frame.windowId),
          });
          return;
        case "screencast.start":
          screencasts
            .start(frame.handoffId, frame.targetId)
            .catch((error: unknown) => {
              logger.warn(
                { err: error, handoffId: frame.handoffId },
                "starting a live view failed",
              );
              sendFrame({
                id: newFrameId(),
                type: "screencast.ended",
                handoffId: frame.handoffId,
                reason: "The live view couldn't start.",
              });
            });
          return;
        case "screencast.stop":
          void screencasts.stop(frame.handoffId);
          return;
        case "input":
          screencasts
            .input(frame.handoffId, frame.input)
            .catch((error: unknown) => {
              logger.warn(
                { err: error, handoffId: frame.handoffId },
                "replaying live-view input failed",
              );
            });
          return;
        case "desktop.open":
          desktops.open(frame.handoffId);
          return;
        case "desktop.close":
          desktops.close(frame.handoffId);
          return;
      }
    },

    binary(message: Uint8Array) {
      const parsed = parseDesktopMessage(message);
      if (parsed) desktops.write(parsed.handoffId, parsed.bytes);
    },

    disconnected() {
      desktops.closeAll();
    },
  };
}
