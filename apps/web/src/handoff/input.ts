/**
 * The live view's input (docs/design.md §5 Browser handoff): what the person
 * does on the phone, as the tab's own input. Coordinates go from the canvas
 * on screen back to the tab's CSS pixels, whatever the scaling or the
 * screen's pixel ratio. A tap is a click and a drag scrolls, as on any
 * phone; a mouse acts directly (press, move, release, wheel).
 */
import type { ViewerInput } from "@winston/domain/frames";

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The tab's viewport the latest frame shows, in CSS pixels. */
export interface FrameSize {
  width: number;
  height: number;
}

/** A point on the canvas (client coordinates) as a point in the tab. */
export function toTab(
  client: { x: number; y: number },
  canvas: Box,
  frame: FrameSize,
) {
  const clamp = (value: number, max: number) =>
    Math.min(Math.max(value, 0), max);
  return {
    x: Math.round(
      clamp(
        ((client.x - canvas.left) / canvas.width) * frame.width,
        frame.width - 1,
      ),
    ),
    y: Math.round(
      clamp(
        ((client.y - canvas.top) / canvas.height) * frame.height,
        frame.height - 1,
      ),
    ),
  };
}

/** How far a finger moves (screen pixels) before a tap becomes a drag. */
export const dragThreshold = 10;

interface Point {
  x: number;
  y: number;
}

/**
 * Turns pointer events into the tab's input. A finger's down and up are
 * held back until it's clear whether it's a tap (a click where it landed)
 * or a drag (wheel scrolling, the content following the finger).
 */
export function createGestures(
  send: (input: ViewerInput) => void,
  geometry: () => { canvas: Box; frame: FrameSize } | undefined,
) {
  let touch: { start: Point; last: Point; dragging: boolean } | undefined;
  let mouseDown = false;

  const at = (client: Point) => {
    const g = geometry();
    return g ? toTab(client, g.canvas, g.frame) : undefined;
  };
  /** Screen pixels to tab pixels, for a drag's distance. */
  const scale = () => {
    const g = geometry();
    return g ? g.frame.width / g.canvas.width : 1;
  };

  return {
    down(client: Point, pointerType: string) {
      if (pointerType === "mouse") {
        const point = at(client);
        if (!point) return;
        mouseDown = true;
        send({ kind: "pointer", action: "down", ...point });
        return;
      }
      touch = { start: client, last: client, dragging: false };
    },
    move(client: Point, pointerType: string) {
      if (pointerType === "mouse") {
        const point = at(client);
        if (point && mouseDown)
          send({ kind: "pointer", action: "move", ...point });
        return;
      }
      if (!touch) return;
      const moved = Math.hypot(
        client.x - touch.start.x,
        client.y - touch.start.y,
      );
      if (!touch.dragging && moved < dragThreshold) return;
      touch.dragging = true;
      const point = at(client);
      if (point) {
        // The page moves with the finger: dragging up scrolls down.
        const s = scale();
        send({
          kind: "wheel",
          ...point,
          deltaX: Math.round((touch.last.x - client.x) * s),
          deltaY: Math.round((touch.last.y - client.y) * s),
        });
      }
      touch.last = client;
    },
    up(client: Point, pointerType: string) {
      if (pointerType === "mouse") {
        const point = at(client);
        if (point && mouseDown)
          send({ kind: "pointer", action: "up", ...point });
        mouseDown = false;
        return;
      }
      const tap = touch && !touch.dragging;
      const start = touch?.start;
      touch = undefined;
      if (!tap || !start) return;
      const point = at(start);
      if (!point) return;
      send({ kind: "pointer", action: "down", ...point });
      send({ kind: "pointer", action: "up", ...point });
    },
    cancel() {
      touch = undefined;
      mouseDown = false;
    },
    wheel(client: Point, deltaX: number, deltaY: number) {
      const point = at(client);
      if (point) send({ kind: "wheel", ...point, deltaX, deltaY });
    },
  };
}

/** Keys sent as keys when typed on a hardware keyboard. */
const namedKeys = new Set([
  "Enter",
  "Backspace",
  "Tab",
  "Escape",
  "Delete",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

export function keyInput(key: string): ViewerInput | undefined {
  return namedKeys.has(key) ? { kind: "key", key } : undefined;
}

/**
 * What changed in the hidden text field, as backspaces then new text. Phone
 * keyboards compose words and autocorrect them in place, so the field's
 * text is compared before and after each change rather than reading keys.
 */
export function textChange(before: string, after: string): ViewerInput[] {
  const was = Array.from(before);
  const now = Array.from(after);
  let same = 0;
  while (same < was.length && same < now.length && was[same] === now[same])
    same += 1;
  const inputs: ViewerInput[] = [];
  for (let i = same; i < was.length; i += 1)
    inputs.push({ kind: "key", key: "Backspace" });
  const added = now.slice(same).join("");
  if (added) inputs.push({ kind: "text", text: added });
  return inputs;
}

/** The page's states. */
export type LiveState =
  | "connecting"
  | "live"
  | "reconnecting"
  | "ended"
  | "expired"
  | "invalid"
  | "elsewhere";

/** What a closed socket means, given whether the page had a session to come back with. */
export function closedState(code: number, hadSession: boolean): LiveState {
  if (code === 4000) return "ended";
  if (code === 4004) return "expired";
  if (code === 4002) return "elsewhere";
  // A used token after we'd connected means our session is gone too.
  if (code === 4003) return "invalid";
  // Anything else (the computer offline, a network blip) is worth retrying.
  return hadSession ? "reconnecting" : "invalid";
}
