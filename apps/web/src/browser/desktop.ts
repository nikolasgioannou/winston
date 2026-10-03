/**
 * The full-desktop fallback (docs/design.md §5): the whole of Winston's
 * screen through noVNC, for native dialogs the tab's live view can't show
 * (`<select>` popups, file pickers, basic-auth prompts). The socket signs in
 * with a ticket of its own, and the gateway opens it only while the person
 * has a window in hand, then tunnels it to the VM's VNC server.
 */
import type { ViewerInput } from "@winston/domain/frames";

/** X keysyms for the named keys the live view sends (input.ts). */
const keysyms: Record<string, number> = {
  Enter: 0xff0d,
  Backspace: 0xff08,
  Tab: 0xff09,
  Escape: 0xff1b,
  Delete: 0xffff,
  ArrowLeft: 0xff51,
  ArrowUp: 0xff52,
  ArrowRight: 0xff53,
  ArrowDown: 0xff54,
  Home: 0xff50,
  End: 0xff57,
  PageUp: 0xff55,
  PageDown: 0xff56,
};

/**
 * The keysyms to type for the live view's key and text input: named keys
 * from the table, Latin-1 characters as themselves, anything else as a
 * Unicode keysym.
 */
export function keysymsFor(input: ViewerInput): number[] {
  if (input.kind === "key") {
    const keysym = keysyms[input.key];
    return keysym === undefined ? [] : [keysym];
  }
  if (input.kind !== "text") return [];
  return Array.from(input.text, (char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 0x100 ? code : 0x1000000 + code;
  });
}

export async function openDesktop({
  url,
  ticket,
  target,
  onEnded,
}: {
  /** The gateway's live-view socket, as for the tab. */
  url: string;
  /** A ticket from the page's server, as for the live view. */
  ticket: string;
  /** Where noVNC draws the screen. */
  target: HTMLElement;
  onEnded: () => void;
}) {
  // noVNC touches the browser as it loads, so only ever here.
  const { default: Rfb } = await import("@novnc/novnc");
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  let rfb: InstanceType<typeof Rfb> | undefined;
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    onEnded();
  };
  ws.addEventListener(
    "open",
    () => {
      ws.send(JSON.stringify({ type: "auth", ticket, desktop: true }));
      // The VNC server speaks first, so noVNC takes over straight away.
      rfb = new Rfb(target, ws);
      // Full size, dragged around to pan (a tap still clicks): the whole
      // screen squeezed onto a phone would be too small to read.
      rfb.clipViewport = true;
      rfb.dragViewport = true;
      rfb.addEventListener("disconnect", end);
    },
    { once: true },
  );
  ws.addEventListener("close", () => {
    if (!rfb) end();
  });
  return {
    type(input: ViewerInput) {
      for (const keysym of keysymsFor(input)) rfb?.sendKey(keysym, null);
    },
    close() {
      ended = true;
      if (rfb) rfb.disconnect();
      else ws.close();
    },
  };
}

export type Desktop = Awaited<ReturnType<typeof openDesktop>>;
