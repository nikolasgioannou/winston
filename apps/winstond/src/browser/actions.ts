/**
 * What's left of acting on a page directly (docs/design.md §5 Browser,
 * §11): a click at a point (the last resort, for what `act` can't operate),
 * waiting, answering dialogs, screenshots and scripts. Everything else on a
 * page goes through `act` (`autopilot.ts`). Input is trusted (`input.ts`);
 * looking at the page (has the DOM gone quiet) runs in an isolated world, a
 * separate JavaScript context the page can't see, and `Runtime.enable`
 * stays off.
 *
 * Every action then waits for the page to settle (the network quiet for
 * 500 ms and no DOM changes for 300 ms, at most 5 s, longer while the
 * window's own document loads, never for frames inside it) and says what
 * happened: where the window is, anything it opened, and any dialog.
 */
import type {
  BrowserActionResponse,
  BrowserEvalResponse,
  BrowserScreenshotResponse,
  BrowserWindowInfo,
} from "@winston/domain/browser";
import type { Cdp } from "./cdp.ts";
import { clickAt } from "./input.ts";
import {
  BrowserFailure,
  browserTimings,
  type OpenDialog,
  type WindowEntry,
} from "./state.ts";

/** What the actions need from the window registry. */
export interface ActionCore {
  caller: (runToken: string) => string;
  windowFor: (
    owner: string,
    windowId: string | undefined,
    access: "own" | "look",
  ) => WindowEntry;
  sessionFor: (entry: WindowEntry) => Promise<{ c: Cdp; sessionId: string }>;
  refresh: (entry: WindowEntry) => Promise<void>;
  info: (entry: WindowEntry, owner: string) => BrowserWindowInfo;
  allWindows: () => WindowEntry[];
  currentOf: (owner: string) => string | undefined;
  now: () => number;
  /** Takes (or renews) the lock for the site a window is on; exit 6 if taken. */
  lock: (owner: string, entry: WindowEntry) => unknown;
  /** Saves a file in Winston's home (as winston), at a path relative to it. */
  saveFile: (path: string, bytes: Uint8Array) => Promise<void>;
}

export const captureLimits = {
  /** A full-page screenshot stops here: taller pages are cut, and said to be. */
  maxFullPageHeight: 12_000,
  /** Characters of an eval result shown. */
  evalChars: 4_000,
};

/**
 * Script as typed: an expression (`document.title`) gives its value; a
 * block of statements gives what it `return`s. Checked by parsing, not
 * running.
 */
export function scriptBody(code: string) {
  try {
    // Parses only (Bun's transpiler); nothing runs here.
    new Bun.Transpiler({ loader: "js" }).transformSync(`(${code}\n);`);
    return `return (${code}\n);`;
  } catch {
    return code;
  }
}

export const settleTimings = {
  networkQuietMs: 500,
  domQuietMs: 300,
  maxMs: 5_000,
  pollMs: 100,
};

/** The dialog a window is waiting on now (it can change while an action runs). */
const pendingDialog = (entry: WindowEntry) => entry.dialog;

/**
 * A page call that gives up when a dialog opens: Chrome holds script and
 * input until the dialog is answered. Resolves undefined in that case.
 */
async function unlessDialog<T>(entry: WindowEntry, call: Promise<T>) {
  call.catch(() => undefined);
  const watch = { on: true };
  const opened = (async () => {
    while (watch.on && !pendingDialog(entry)) await Bun.sleep(50);
    return undefined;
  })();
  try {
    return await Promise.race([call, opened]);
  } finally {
    watch.on = false;
  }
}

/** How a dialog waiting for an answer reads. */
export const dialogText = (dialog: OpenDialog) =>
  `The page is asking (${dialog.type}): "${dialog.message}"`;

export function createActions(core: ActionCore) {
  /** The isolated world for a session's main frame, made once per document. */
  async function worldFor(entry: WindowEntry, c: Cdp, sessionId: string) {
    const { frameTree } = await c.send<{
      frameTree: { frame: { id: string } };
    }>("Page.getFrameTree", {}, sessionId);
    const key = `${sessionId}:${frameTree.frame.id}`;
    const known = entry.worlds.get(key);
    if (known !== undefined) return known;
    const { executionContextId } = await c.send<{ executionContextId: number }>(
      "Page.createIsolatedWorld",
      { frameId: frameTree.frame.id, worldName: "winston" },
      sessionId,
    );
    entry.worlds.set(key, executionContextId);
    return executionContextId;
  }

  /** Waits for the page to settle; false if it was still busy at the end. */
  async function settle(
    entry: WindowEntry,
    c: Cdp,
    sessionId: string,
    maxMs: number,
  ) {
    const started = core.now();
    // A MutationObserver in the isolated world, which the page can't see.
    let world: number | undefined;
    const watchDom = async () => {
      world = await worldFor(entry, c, sessionId);
      await c.send(
        "Runtime.evaluate",
        {
          expression:
            "globalThis.__winstonDom ??= (() => { const s = { last: Date.now() }; new MutationObserver(() => { s.last = Date.now(); }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true }); return s; })(), true",
          contextId: world,
        },
        sessionId,
      );
    };
    await unlessDialog(entry, watchDom()).catch(() => undefined);
    for (;;) {
      if (pendingDialog(entry)) return true;
      const elapsed = core.now() - started;
      const { loading } = entry;
      const limit = loading ? browserTimings.loadTimeoutMs : maxMs;
      if (elapsed >= limit) return false;
      if (
        !loading &&
        core.now() - entry.lastNetwork >= settleTimings.networkQuietMs
      ) {
        let domQuiet: boolean;
        try {
          if (world === undefined) await unlessDialog(entry, watchDom());
          const answer = await unlessDialog(
            entry,
            c.send<{ result: { value?: number } }>(
              "Runtime.evaluate",
              {
                expression: "Date.now() - globalThis.__winstonDom.last",
                contextId: world,
                returnByValue: true,
              },
              sessionId,
            ),
          );
          if (!answer) return true;
          domQuiet =
            (answer.result.value ?? Infinity) >= settleTimings.domQuietMs;
        } catch {
          // A new document: its world is gone; watch the new one next time.
          world = undefined;
          domQuiet = false;
        }
        if (domQuiet) return true;
      }
      await Bun.sleep(settleTimings.pollMs);
    }
  }

  /** Runs an action in the caller's window and reports what happened. */
  async function act(
    runToken: string,
    windowId: string | undefined,
    did: string | ((entry: WindowEntry) => string),
    run: (entry: WindowEntry, c: Cdp, sessionId: string) => Promise<unknown>,
  ): Promise<BrowserActionResponse> {
    const owner = core.caller(runToken);
    const entry = core.windowFor(owner, windowId, "own");
    if (entry.dialog)
      throw new BrowserFailure(
        "invalid_request",
        `${dialogText(entry.dialog)}, and it blocks the page until answered.`,
        "Answer it with winston browser dialog accept (or dismiss).",
      );
    // Acting on a site needs its lock (exit 6 if another task has it).
    core.lock(owner, entry);
    const { c, sessionId } = await core.sessionFor(entry);
    const started = core.now();
    entry.lastUsedAt = started;
    entry.handledDialogs = [];
    const before = entry.url;
    // A dialog the action opens (a click on "Delete" asking to confirm)
    // holds Chrome's reply to the input until it's answered, so the action
    // is done as soon as one appears; the reply arrives once it's answered.
    const result = await unlessDialog(entry, run(entry, c, sessionId));
    const note = typeof result === "string" ? result : undefined;
    const settled = await settle(entry, c, sessionId, settleTimings.maxMs);
    const alive = core.allWindows().includes(entry);
    if (alive) await core.refresh(entry).catch(() => undefined);
    const opened = core
      .allWindows()
      .filter(
        (other) =>
          other.owner === owner &&
          other.openedBy !== null &&
          other.createdAt >= started,
      );
    const shown = alive
      ? entry
      : (core.allWindows().find((w) => w.id === core.currentOf(owner)) ??
        entry);
    return {
      did: typeof did === "string" ? did : did(entry),
      ...(note ? { note } : {}),
      window: core.info(shown, owner),
      navigated: alive && entry.url !== before,
      settled,
      opened: opened.map((other) => core.info(other, owner)),
      // Read again: a dialog may have opened while the action ran.
      dialog: pendingDialog(entry) ?? null,
      handledDialogs: entry.handledDialogs,
    };
  }

  return {
    async screenshot(
      runToken: string,
      request: { window?: string | undefined; fullPage?: boolean },
    ): Promise<BrowserScreenshotResponse> {
      const owner = core.caller(runToken);
      // A peek at another run's window is fine: it changes nothing.
      const entry = core.windowFor(owner, request.window, "look");
      const { c, sessionId } = await core.sessionFor(entry);
      const metrics = await c.send<{
        cssVisualViewport: { clientWidth: number; clientHeight: number };
        cssContentSize: { width: number; height: number };
      }>("Page.getLayoutMetrics", {}, sessionId);
      const full = request.fullPage === true;
      const width = Math.round(metrics.cssVisualViewport.clientWidth);
      const pageHeight = Math.round(metrics.cssContentSize.height);
      const height = full
        ? Math.min(pageHeight, captureLimits.maxFullPageHeight)
        : Math.round(metrics.cssVisualViewport.clientHeight);
      const shot = await unlessDialog(
        entry,
        c.send<{ data: string }>(
          "Page.captureScreenshot",
          {
            format: "png",
            ...(full
              ? {
                  captureBeyondViewport: true,
                  clip: { x: 0, y: 0, width, height, scale: 1 },
                }
              : {}),
          },
          sessionId,
        ),
      );
      if (!shot)
        throw new BrowserFailure(
          "invalid_request",
          `${dialogText(pendingDialog(entry) ?? { type: "dialog", message: "", defaultPrompt: "" })}, so the page can't be captured.`,
          "Answer it with winston browser dialog accept (or dismiss).",
        );
      const stamp = new Date(core.now()).toISOString().replace(/[:.]/g, "-");
      const path = `.winston/screenshots/${owner}/${stamp}-${entry.id}.png`;
      await core.saveFile(path, Buffer.from(shot.data, "base64"));
      await core.refresh(entry).catch(() => undefined);
      return {
        window: core.info(entry, owner),
        path: `/home/winston/${path}`,
        width,
        height,
        fullPage: full,
        clipped: full && pageHeight > height,
      };
    },

    async eval(
      runToken: string,
      request: { code: string; pageWorld?: boolean },
      windowId?: string,
    ): Promise<BrowserEvalResponse> {
      const owner = core.caller(runToken);
      const entry = core.windowFor(owner, windowId, "own");
      if (entry.dialog)
        throw new BrowserFailure(
          "invalid_request",
          `${dialogText(entry.dialog)}, and it blocks the page until answered.`,
          "Answer it with winston browser dialog accept (or dismiss).",
        );
      core.lock(owner, entry);
      entry.lastUsedAt = core.now();
      const { c, sessionId } = await core.sessionFor(entry);
      const body = scriptBody(request.code);
      interface Evaluated {
        result: { type: string; value?: unknown; description?: string };
        exceptionDetails?: {
          text: string;
          exception?: { description?: string };
        };
      }
      let evaluated: Evaluated | undefined;
      if (request.pageWorld) {
        // The page's own world, for its variables: through its document
        // node, so Runtime.enable stays off.
        const { root } = await c.send<{ root: { backendNodeId: number } }>(
          "DOM.getDocument",
          { depth: 0 },
          sessionId,
        );
        const { object } = await c.send<{ object: { objectId: string } }>(
          "DOM.resolveNode",
          { backendNodeId: root.backendNodeId },
          sessionId,
        );
        evaluated = await unlessDialog(
          entry,
          c.send<Evaluated>(
            "Runtime.callFunctionOn",
            {
              objectId: object.objectId,
              functionDeclaration: `async function () {\n${body}\n}`,
              returnByValue: true,
              awaitPromise: true,
            },
            sessionId,
          ),
        );
      } else {
        const world = await worldFor(entry, c, sessionId);
        evaluated = await unlessDialog(
          entry,
          c.send<Evaluated>(
            "Runtime.evaluate",
            {
              expression: `(async () => {\n${body}\n})()`,
              contextId: world,
              returnByValue: true,
              awaitPromise: true,
              timeout: 30_000,
            },
            sessionId,
          ),
        );
      }
      if (!evaluated)
        throw new BrowserFailure(
          "invalid_request",
          `The script opened a dialog. ${dialogText(pendingDialog(entry) ?? { type: "dialog", message: "", defaultPrompt: "" })}.`,
          "Answer it with winston browser dialog accept (or dismiss).",
        );
      if (evaluated.exceptionDetails)
        throw new BrowserFailure(
          "invalid_request",
          `The script threw: ${evaluated.exceptionDetails.exception?.description?.split("\n")[0] ?? evaluated.exceptionDetails.text}`,
          request.pageWorld
            ? "Fix the script and run it again."
            : "Fix the script and run it again. It runs apart from the page's own scripts; add --page-world to reach their variables.",
        );
      const { result } = evaluated;
      // JSON.stringify gives undefined for a function or a symbol.
      const serialized = JSON.stringify(result.value, null, 2) as
        string | undefined;
      const json =
        result.type === "undefined"
          ? "undefined"
          : (serialized ?? String(result.description));
      const chars = Array.from(json);
      return {
        window: core.info(entry, owner),
        value: chars.slice(0, captureLimits.evalChars).join(""),
        more: Math.max(0, chars.length - captureLimits.evalChars),
      };
    },

    clickXY(runToken: string, x: number, y: number, windowId?: string) {
      return act(
        runToken,
        windowId,
        `Clicked at (${String(x)}, ${String(y)}).`,
        async (_entry, c, s) => {
          await clickAt(c, s, { x, y });
        },
      );
    },

    async wait(
      runToken: string,
      request: { text?: string | undefined; timeoutMs: number },
      windowId?: string,
    ): Promise<BrowserActionResponse> {
      return act(
        runToken,
        windowId,
        (entry) => {
          if (request.text) return `"${request.text}" is on the page.`;
          return entry.url ? "The page is settled." : "Done.";
        },
        async (entry, c, s) => {
          const deadline = core.now() + request.timeoutMs;
          const found = async () => {
            if (request.text) {
              try {
                const world = await worldFor(entry, c, s);
                const { result } = await c.send<{
                  result: { value?: boolean };
                }>(
                  "Runtime.evaluate",
                  {
                    expression: `!!document.body && document.body.innerText.includes(${JSON.stringify(request.text)})`,
                    contextId: world,
                    returnByValue: true,
                  },
                  s,
                );
                return result.value === true;
              } catch {
                entry.worlds.clear();
                return false;
              }
            }
            return settle(entry, c, s, request.timeoutMs);
          };
          while (!(await found())) {
            if (core.now() >= deadline)
              throw new BrowserFailure(
                "unavailable",
                request.text
                  ? `"${request.text}" didn't appear within ${String(Math.round(request.timeoutMs / 1000))} s.`
                  : `The page was still busy after ${String(Math.round(request.timeoutMs / 1000))} s.`,
                "Snapshot to see where the page is.",
              );
            await Bun.sleep(250);
          }
        },
      );
    },

    async dialog(
      runToken: string,
      answer: { accept: boolean; text?: string | undefined },
      windowId?: string,
    ): Promise<BrowserActionResponse> {
      const owner = core.caller(runToken);
      const entry = core.windowFor(owner, windowId, "own");
      const open = entry.dialog;
      if (!open)
        throw new BrowserFailure(
          "invalid_request",
          "No dialog is waiting in your window.",
        );
      const { c, sessionId } = await core.sessionFor(entry);
      await c.send(
        "Page.handleJavaScriptDialog",
        {
          accept: answer.accept,
          ...(answer.text !== undefined ? { promptText: answer.text } : {}),
        },
        sessionId,
      );
      entry.dialog = undefined;
      return act(
        runToken,
        windowId,
        `${answer.accept ? "Accepted" : "Dismissed"} the ${open.type}: "${open.message}".`,
        () => Promise.resolve(),
      );
    },
  };
}
