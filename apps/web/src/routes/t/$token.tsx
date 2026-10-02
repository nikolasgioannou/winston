import { createFileRoute } from "@tanstack/react-router";
import type { ScreencastHeader, ViewerInput } from "@winston/domain/frames";
import { useEffect, useRef, useState } from "react";
import { browserSessions, connectLiveView } from "../../handoff/connection";
import { openDesktop, type Desktop } from "../../handoff/desktop";
import {
  createGestures,
  keyInput,
  textChange,
  type FrameSize,
  type LiveState,
} from "../../handoff/input";
import { HandoffPage } from "../../pages/handoff-page";
import { getLiveViewUrl } from "../../server/handoff-functions";

// A handoff link's live view (docs/design.md §5). Public: the token in the
// address is the credential, so the page never sends it on as a referrer
// and asks not to be indexed.
export const Route = createFileRoute("/t/$token")({
  loader: () => getLiveViewUrl(),
  head: () => ({
    meta: [
      { title: "Winston: your turn" },
      { name: "referrer", content: "no-referrer" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: LiveView,
});

function LiveView() {
  const { token } = Route.useParams();
  const url = Route.useLoaderData();
  const [state, setState] = useState<LiveState>("connecting");
  const canvas = useRef<HTMLCanvasElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const frame = useRef<FrameSize | undefined>(undefined);
  const link = useRef<ReturnType<typeof connectLiveView> | undefined>(
    undefined,
  );
  const typed = useRef("");
  const gestures = useRef<ReturnType<typeof createGestures>>(undefined);
  const [showDesktop, setShowDesktop] = useState(false);
  const desktopArea = useRef<HTMLDivElement>(null);
  const desktop = useRef<Desktop | undefined>(undefined);

  useEffect(() => {
    // Draws frames as they arrive. While one decodes, only the newest one
    // waiting is kept, and it's drawn next: a page that stops changing
    // always ends on its last frame.
    let drawing = false;
    let waiting: { header: ScreencastHeader; jpeg: Uint8Array } | undefined;
    const draw = async (header: ScreencastHeader, jpeg: Uint8Array) => {
      if (drawing) {
        waiting = { header, jpeg };
        return;
      }
      const target = canvas.current;
      if (!target) return;
      drawing = true;
      try {
        const bitmap = await createImageBitmap(
          new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }),
        );
        target.width = bitmap.width;
        target.height = bitmap.height;
        target.getContext("2d")?.drawImage(bitmap, 0, 0);
        bitmap.close();
        frame.current = { width: header.width, height: header.height };
      } finally {
        drawing = false;
      }
      const next = waiting;
      waiting = undefined;
      if (next) await draw(next.header, next.jpeg);
    };
    const connection = connectLiveView({
      url,
      token,
      sessions: browserSessions,
      onState: setState,
      onFrame: (header, jpeg) => {
        void draw(header, jpeg);
      },
    });
    link.current = connection;
    gestures.current = createGestures(
      (input) => {
        connection.send(input);
      },
      () => {
        const rect = canvas.current?.getBoundingClientRect();
        return rect && frame.current
          ? { canvas: rect, frame: frame.current }
          : undefined;
      },
    );
    return () => {
      connection.close();
    };
  }, [url, token]);

  // The tab is shown at this page's size: each time the view goes live
  // (a new session on the VM) and when the phone turns or resizes.
  useEffect(() => {
    if (state !== "live") return;
    const send = () => {
      const area = canvas.current?.parentElement?.getBoundingClientRect();
      if (!area) return;
      link.current?.send({
        kind: "viewport",
        width: Math.round(area.width),
        height: Math.round(area.height),
        scale: Math.min(Math.max(window.devicePixelRatio, 1), 4),
      });
    };
    send();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const resized = () => {
      clearTimeout(timer);
      timer = setTimeout(send, 200);
    };
    window.addEventListener("resize", resized);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("resize", resized);
    };
  }, [state]);

  // The full desktop, while it's showing and the view is live: its own
  // socket, signed in with this page's session.
  useEffect(() => {
    const session = link.current?.session();
    const target = desktopArea.current;
    if (!showDesktop || state !== "live" || !session || !target) return;
    let cancelled = false;
    void openDesktop({
      url,
      session,
      target,
      onEnded: () => {
        setShowDesktop(false);
      },
    }).then((opened) => {
      if (cancelled) opened.close();
      else desktop.current = opened;
    });
    return () => {
      cancelled = true;
      desktop.current?.close();
      desktop.current = undefined;
    };
  }, [showDesktop, state, url]);

  /** Typing goes to the full desktop while it's showing, else to the tab. */
  const type = (input: ViewerInput) => {
    if (showDesktop) desktop.current?.type(input);
    else link.current?.send(input);
  };

  const point = (event: { clientX: number; clientY: number }) => ({
    x: event.clientX,
    y: event.clientY,
  });

  return (
    <HandoffPage
      state={state}
      onKeyboard={() => field.current?.focus()}
      onDone={() => link.current?.done()}
      desktop={{
        open: showDesktop,
        onToggle: () => {
          setShowDesktop((open) => !open);
        },
      }}
      screen={
        <>
          {showDesktop && <div ref={desktopArea} className="size-full" />}
          <canvas
            ref={canvas}
            className={`${showDesktop ? "hidden" : "block"} size-auto max-h-full max-w-full touch-none select-none`}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              gestures.current?.down(point(event), event.pointerType);
            }}
            onPointerMove={(event) => {
              gestures.current?.move(point(event), event.pointerType);
            }}
            onPointerUp={(event) => {
              gestures.current?.up(point(event), event.pointerType);
            }}
            onPointerCancel={() => {
              gestures.current?.cancel();
            }}
            onWheel={(event) => {
              gestures.current?.wheel(point(event), event.deltaX, event.deltaY);
            }}
            onContextMenu={(event) => {
              event.preventDefault();
            }}
          />
        </>
      }
      keyboard={
        // Off to the side but focusable, so it brings up the keyboard; 16px
        // text keeps iOS from zooming in when it's focused.
        <input
          ref={field}
          aria-label="Type into Winston's browser"
          className="pointer-events-none absolute size-px text-[16px] opacity-0"
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            const send = (key: string) => {
              type({ kind: "key", key });
            };
            if (event.key === "Enter") {
              event.preventDefault();
              send("Enter");
              event.currentTarget.value = "";
              typed.current = "";
              return;
            }
            // Deleting past what was typed here deletes in the page.
            if (event.key === "Backspace" && event.currentTarget.value === "") {
              send("Backspace");
              return;
            }
            const key =
              event.key === "Backspace" ? undefined : keyInput(event.key);
            if (key) {
              event.preventDefault();
              type(key);
            }
          }}
          onInput={(event) => {
            const now = event.currentTarget.value;
            for (const input of textChange(typed.current, now)) type(input);
            typed.current = now;
          }}
          onBlur={(event) => {
            event.currentTarget.value = "";
            typed.current = "";
          }}
        />
      }
    />
  );
}
