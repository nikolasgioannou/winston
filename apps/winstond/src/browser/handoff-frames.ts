/**
 * The gateway's browser handoff frames (docs/design.md §5, §15): hold a
 * run's window for the user, let it go, and run that tab's live view.
 */
import { newFrameId, type VmToGatewayFrame } from "@winston/domain/frames";
import type { Logger } from "@winston/shared/logger";
import type { BrowserFrame } from "../daemon.ts";
import type { Screencasts } from "./screencast.ts";
import type { Browser } from "./windows.ts";

export function handoffFrames({
  browser,
  screencasts,
  sendFrame,
  logger,
}: {
  browser: Pick<Browser, "hold" | "release">;
  screencasts: Screencasts;
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
          browser.release(frame.owner);
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
      }
    },
  };
}
