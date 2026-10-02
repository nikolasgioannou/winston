/**
 * Trusted input through CDP's Input domain: the events Chrome itself makes
 * for a real mouse and keyboard (`isTrusted`), sent to the page's session
 * with small human-paced pauses. Pages can't tell them from a person's,
 * unlike events dispatched from script.
 */
import type { Cdp } from "./cdp.ts";

/** A pause of `min`–`max` ms, so input doesn't arrive in one burst. */
const pause = (min: number, max: number) =>
  Bun.sleep(min + Math.floor(Math.random() * (max - min)));

export interface Point {
  x: number;
  y: number;
}

/** Moves to a point and clicks there, as a mouse does. */
export async function clickAt(c: Cdp, sessionId: string, point: Point) {
  const at = { x: point.x, y: point.y };
  await c.send(
    "Input.dispatchMouseEvent",
    { type: "mouseMoved", ...at },
    sessionId,
  );
  await pause(30, 80);
  await c.send(
    "Input.dispatchMouseEvent",
    { type: "mousePressed", ...at, button: "left", buttons: 1, clickCount: 1 },
    sessionId,
  );
  await pause(40, 110);
  await c.send(
    "Input.dispatchMouseEvent",
    { type: "mouseReleased", ...at, button: "left", buttons: 0, clickCount: 1 },
    sessionId,
  );
}

/** Scrolls with the mouse wheel at a point. */
export async function wheel(
  c: Cdp,
  sessionId: string,
  point: Point,
  deltaY: number,
) {
  await c.send(
    "Input.dispatchMouseEvent",
    { type: "mouseWheel", x: point.x, y: point.y, deltaX: 0, deltaY },
    sessionId,
  );
}

interface KeyDefinition {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
}

/** The named keys `browser press` takes, as Chrome describes them. */
export const keys = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
} as const satisfies Record<string, KeyDefinition>;

const modifierBits: Record<string, number | undefined> = {
  Alt: 1,
  Control: 2,
  Ctrl: 2,
  Meta: 4,
  Shift: 8,
};

/**
 * Parses `Enter`, `Control+a` or `Shift+Tab` into a key and modifiers.
 * Returns undefined for keys it doesn't know.
 */
export function parseKey(spec: string) {
  const parts = spec.split("+");
  const name = parts.pop() ?? "";
  let modifiers = 0;
  for (const part of parts) {
    const bit = modifierBits[part];
    if (bit === undefined) return undefined;
    modifiers |= bit;
  }
  const named = (Object.entries(keys) as [string, KeyDefinition][]).find(
    ([k]) => k.toLowerCase() === name.toLowerCase(),
  )?.[1];
  if (named) return { ...named, modifiers };
  // A single character: a letter, digit or symbol.
  if (Array.from(name).length === 1) {
    const upper = name.toUpperCase();
    const isLetter = /^[A-Z]$/.test(upper);
    const isDigit = /^[0-9]$/.test(name);
    return {
      key: name,
      code: isLetter ? `Key${upper}` : isDigit ? `Digit${name}` : "",
      keyCode: isLetter || isDigit ? upper.charCodeAt(0) : 0,
      // With Control, Alt or Meta held a letter is a shortcut, not text.
      ...(modifiers & ~8 ? {} : { text: name }),
      modifiers,
    };
  }
  return undefined;
}

/** Presses and releases one key (with modifiers). */
export async function press(
  c: Cdp,
  sessionId: string,
  key: KeyDefinition & { modifiers?: number },
) {
  const common = {
    key: key.key,
    code: key.code,
    windowsVirtualKeyCode: key.keyCode,
    modifiers: key.modifiers ?? 0,
  };
  await c.send(
    "Input.dispatchKeyEvent",
    {
      type: key.text ? "keyDown" : "rawKeyDown",
      ...common,
      ...(key.text ? { text: key.text, unmodifiedText: key.text } : {}),
    },
    sessionId,
  );
  await pause(20, 60);
  await c.send(
    "Input.dispatchKeyEvent",
    { type: "keyUp", ...common },
    sessionId,
  );
}

/** Text typed key by key up to this length; longer text is inserted at once. */
const typedLimit = 120;

/**
 * Types text into the focused element. Short text goes key by key, so sites
 * that listen for keystrokes (autocomplete) see them; long text is inserted
 * in one input event.
 */
export async function typeText(c: Cdp, sessionId: string, text: string) {
  if (Array.from(text).length > typedLimit) {
    await c.send("Input.insertText", { text }, sessionId);
    return;
  }
  for (const char of text) {
    if (char === "\n") await press(c, sessionId, keys.Enter);
    else {
      await c.send(
        "Input.dispatchKeyEvent",
        { type: "keyDown", key: char, text: char, unmodifiedText: char },
        sessionId,
      );
      await c.send(
        "Input.dispatchKeyEvent",
        { type: "keyUp", key: char },
        sessionId,
      );
    }
    await pause(15, 45);
  }
}
