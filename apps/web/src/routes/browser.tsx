import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import type { BrowserPageWindow } from "@winston/domain/browser";
import type { ScreencastHeader, ViewerInput } from "@winston/domain/frames";
import { toast } from "@winston/ui";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { z } from "zod";
import {
  connectBrowser,
  type ConnectionState,
  type GatewayMessage,
} from "../browser/connection";
import { openDesktop, type Desktop } from "../browser/desktop";
import {
  createGestures,
  keyInput,
  textChange,
  type FrameSize,
} from "../browser/input";
import { BrowserPage } from "../pages/browser-page";
import { getBrowserPage, getViewerTicket } from "../server/browser-functions";
import { getSessionUser } from "../server/session-functions";

/** How often the window list refreshes while the page is open. */
const listEveryMs = 4_000;

// Winston's browser, live, for the signed-in user (docs/design.md §5): a
// link from Telegram opens it at a window (`?window=`). Signed out, it goes
// through sign-in and comes back here.
export const Route = createFileRoute("/browser")({
  validateSearch: z.object({ window: z.string().optional() }),
  beforeLoad: async ({ location }) => {
    if (!(await getSessionUser()))
      throw redirect({ to: "/", search: { next: location.href } });
  },
  loader: () => getBrowserPage(),
  head: () => ({
    meta: [
      { title: "Winston's browser" },
      { name: "referrer", content: "no-referrer" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: LiveBrowser,
});

function LiveBrowser() {
  const { url } = Route.useLoaderData();
  const { window: wanted } = Route.useSearch();
  const navigate = useNavigate({ from: "/browser" });
  const [state, setState] = useState<ConnectionState>("connecting");
  const [windows, setWindows] = useState<BrowserPageWindow[]>();
  const [selectedId, setSelectedId] = useState<string | undefined>(wanted);
  const [control, setControl] = useState(false);
  const [showDesktop, setShowDesktop] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const desktopArea = useRef<HTMLDivElement>(null);
  const frame = useRef<FrameSize | undefined>(undefined);
  const link = useRef<ReturnType<typeof connectBrowser>>(undefined);
  const gestures = useRef<ReturnType<typeof createGestures>>(undefined);
  const desktop = useRef<Desktop | undefined>(undefined);
  const typed = useRef("");
  // The latest choice, for the socket's callbacks: set wherever the choice
  // changes, since a message can arrive before the next render.
  const selection = useRef(wanted);

  const watch = (windowId: string) => {
    setSelectedId(windowId);
    selection.current = windowId;
    setControl(false);
    frame.current = undefined;
    link.current?.ask({ type: "watch", windowId });
    void navigate({ search: { window: windowId }, replace: true });
  };
  // The same, from the socket's messages, without remaking the socket.
  const watchFromSocket = useEffectEvent((windowId: string) => {
    watch(windowId);
  });

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

    const onMessage = (message: GatewayMessage) => {
      switch (message.type) {
        case "ready":
          // Signed in (again): the list, and the window being watched.
          connection.ask({ type: "windows" });
          if (selection.current)
            connection.ask({ type: "watch", windowId: selection.current });
          return;
        case "windows": {
          const list = message.windows as BrowserPageWindow[];
          setWindows(list);
          const current = selection.current;
          if (current && list.some((w) => w.id === current)) {
            setControl(list.find((w) => w.id === current)?.control === "you");
            return;
          }
          // Nothing chosen (or it closed): the one waiting on the person, else the latest.
          const pick = list.find((w) => w.held === "handoff") ?? list[0];
          if (pick) watchFromSocket(pick.id);
          else {
            setSelectedId(undefined);
            selection.current = undefined;
          }
          return;
        }
        case "watching":
          if (message.windowId === selection.current)
            setControl(message.control === true);
          return;
        case "control":
          if (message.windowId === selection.current)
            setControl(message.yours === true);
          connection.ask({ type: "windows" });
          return;
        case "ended":
          if (message.windowId === selection.current) {
            frame.current = undefined;
            setControl(false);
            setSelectedId(undefined);
            selection.current = undefined;
            connection.ask({ type: "windows" });
          }
          return;
        case "error":
          toast.error(
            typeof message.message === "string"
              ? message.message
              : "Something went wrong.",
          );
          return;
      }
    };

    const connection = connectBrowser({
      url,
      ticket: async () => (await getViewerTicket()).ticket,
      onState: setState,
      onMessage,
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
    const refresh = setInterval(() => {
      connection.ask({ type: "windows" });
    }, listEveryMs);
    return () => {
      clearInterval(refresh);
      connection.close();
    };
  }, [url]);

  // With control, the tab is shown at this page's size (a phone gets the
  // site's mobile layout), each time control comes and when the page resizes.
  // Watching never resizes it: Winston keeps working at his own size.
  useEffect(() => {
    if (state !== "live" || !control) return;
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
  }, [state, control]);

  // The full desktop, while it's showing and the page has control: its own
  // socket, signed in with a ticket of its own.
  useEffect(() => {
    const target = desktopArea.current;
    if (!showDesktop || !control || !target) return;
    let cancelled = false;
    void getViewerTicket().then(({ ticket }) =>
      openDesktop({
        url,
        ticket,
        target,
        onEnded: () => {
          setShowDesktop(false);
        },
      }).then((opened) => {
        if (cancelled) opened.close();
        else desktop.current = opened;
      }),
    );
    return () => {
      cancelled = true;
      desktop.current?.close();
      desktop.current = undefined;
    };
  }, [showDesktop, control, url]);

  /** Typing goes to the full desktop while it's showing, else to the tab. */
  const type = (input: ViewerInput) => {
    if (showDesktop) desktop.current?.type(input);
    else link.current?.send(input);
  };

  const point = (event: { clientX: number; clientY: number }) => ({
    x: event.clientX,
    y: event.clientY,
  });
  const selected = windows?.find((w) => w.id === selectedId);

  return (
    <BrowserPage
      state={state}
      windows={windows}
      selected={selected}
      control={control}
      onSelect={watch}
      onTakeOver={() => {
        link.current?.ask({ type: "control" });
      }}
      onDone={() => {
        setShowDesktop(false);
        link.current?.ask({ type: "done" });
      }}
      onKeyboard={() => field.current?.focus()}
      desktop={
        control
          ? {
              open: showDesktop,
              onToggle: () => {
                setShowDesktop((open) => !open);
              },
            }
          : undefined
      }
      screen={
        <>
          {showDesktop && <div ref={desktopArea} className="size-full" />}
          <canvas
            ref={canvas}
            className={`${showDesktop ? "hidden" : "block"} size-auto max-h-full max-w-full select-none ${control ? "touch-none" : ""}`}
            onPointerDown={(event) => {
              if (!control) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              gestures.current?.down(point(event), event.pointerType);
            }}
            onPointerMove={(event) => {
              if (control)
                gestures.current?.move(point(event), event.pointerType);
            }}
            onPointerUp={(event) => {
              if (!control) return;
              gestures.current?.up(point(event), event.pointerType);
              // A click takes the focus off the typing field (emptying it),
              // so it goes back and keys keep reaching the tab, as in any
              // browser. Not for touch: it would bring up the phone's keyboard.
              if (event.pointerType === "mouse") field.current?.focus();
            }}
            onPointerCancel={() => {
              gestures.current?.cancel();
            }}
            onWheel={(event) => {
              if (control)
                gestures.current?.wheel(
                  point(event),
                  event.deltaX,
                  event.deltaY,
                );
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
