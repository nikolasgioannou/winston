/**
 * Acting on a page (docs/design.md §5 Browser, §11): click, type, select,
 * press, scroll, a coordinate fallback, and waiting. Input is trusted
 * (`input.ts`); looking at the page (is this node still there, what's at
 * this point, has the DOM gone quiet) runs in an isolated world, a separate
 * JavaScript context the page can't see, and `Runtime.enable` stays off.
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
import {
  clickAt,
  keys,
  parseKey,
  press,
  typeText,
  wheel,
  type Point,
} from "./input.ts";
import type { RefTarget } from "./snapshot.ts";
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

const isMissingNode = (error: unknown) =>
  error instanceof Error &&
  /No node|Could not find node|not found/i.test(error.message);

export function createActions(core: ActionCore) {
  /** The isolated world for a target's frame, made once per document. */
  async function worldFor(entry: WindowEntry, c: Cdp, target: RefTarget) {
    let frameId = target.frameId;
    if (!frameId) {
      const { frameTree } = await c.send<{
        frameTree: { frame: { id: string } };
      }>("Page.getFrameTree", {}, target.sessionId);
      frameId = frameTree.frame.id;
    }
    const key = `${target.sessionId}:${frameId}`;
    const known = entry.worlds.get(key);
    if (known !== undefined) return known;
    const { executionContextId } = await c.send<{ executionContextId: number }>(
      "Page.createIsolatedWorld",
      { frameId, worldName: "winston" },
      target.sessionId,
    );
    entry.worlds.set(key, executionContextId);
    return executionContextId;
  }

  /** The node behind a ref, as an object in the isolated world; fails if it's gone. */
  async function objectFor(
    entry: WindowEntry,
    c: Cdp,
    ref: string,
    target: RefTarget,
  ) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const executionContextId = await worldFor(entry, c, target);
      try {
        const { object } = await c.send<{ object: { objectId: string } }>(
          "DOM.resolveNode",
          { backendNodeId: target.backendNodeId, executionContextId },
          target.sessionId,
        );
        return object.objectId;
      } catch (error) {
        if (isMissingNode(error)) break;
        // The world went with a document we didn't see go: make a new one.
        entry.worlds.clear();
      }
    }
    throw new BrowserFailure(
      "invalid_request",
      `${ref} (${target.label}) is no longer on the page.`,
      "The page changed since your snapshot; take a new snapshot.",
    );
  }

  async function callOn<T>(
    c: Cdp,
    sessionId: string,
    objectId: string,
    fn: string,
    args: unknown[] = [],
  ): Promise<T> {
    const { result, exceptionDetails } = await c.send<{
      result: { value?: unknown };
      exceptionDetails?: { text: string };
    }>(
      "Runtime.callFunctionOn",
      {
        objectId,
        functionDeclaration: fn,
        arguments: args.map((value) => ({ value })),
        returnByValue: true,
        awaitPromise: true,
      },
      sessionId,
    );
    if (exceptionDetails)
      throw new BrowserFailure("invalid_request", exceptionDetails.text);
    return result.value as T;
  }

  function refTarget(entry: WindowEntry, ref: string) {
    const target = entry.refs.get(ref);
    if (!target)
      throw new BrowserFailure(
        "invalid_request",
        `There's no ${ref} in your last snapshot of ${entry.id}.`,
        "Refs change as the page does; take a new snapshot and use a ref from it.",
      );
    return target;
  }

  /** The middle of a node's visible box, in the page's viewport. */
  async function centerOf(
    c: Cdp,
    ref: string,
    target: RefTarget,
  ): Promise<Point> {
    await c
      .send(
        "DOM.scrollIntoViewIfNeeded",
        { backendNodeId: target.backendNodeId },
        target.sessionId,
      )
      .catch(() => undefined);
    const box = async (sessionId: string, backendNodeId: number) => {
      const { quads } = await c.send<{ quads: number[][] }>(
        "DOM.getContentQuads",
        { backendNodeId },
        sessionId,
      );
      // The largest visible piece (a wrapped link has several).
      const area = (q: number[]) =>
        Math.abs(((q[2] ?? 0) - (q[0] ?? 0)) * ((q[5] ?? 0) - (q[1] ?? 0)));
      return quads
        .filter((q) => area(q) > 1)
        .sort((a, b) => area(b) - area(a))[0];
    };
    const quad = await box(target.sessionId, target.backendNodeId).catch(
      () => undefined,
    );
    if (!quad)
      throw new BrowserFailure(
        "invalid_request",
        `${ref} (${target.label}) isn't visible, so it can't be clicked.`,
        "It may be hidden or collapsed; open what contains it, then snapshot again.",
      );
    const point = {
      x:
        ((quad[0] ?? 0) + (quad[2] ?? 0) + (quad[4] ?? 0) + (quad[6] ?? 0)) / 4,
      y:
        ((quad[1] ?? 0) + (quad[3] ?? 0) + (quad[5] ?? 0) + (quad[7] ?? 0)) / 4,
    };
    // A cross-site frame's coordinates start at its <iframe>.
    if (target.offsetFrom) {
      const frame = await box(
        target.offsetFrom.sessionId,
        target.offsetFrom.backendNodeId,
      ).catch(() => undefined);
      if (frame) {
        point.x += Math.min(frame[0] ?? 0, frame[6] ?? 0);
        point.y += Math.min(frame[1] ?? 0, frame[3] ?? 0);
      }
    }
    return point;
  }

  /** Fails if something else (a banner, an overlay) is on top at that point. */
  async function checkNotCovered(
    c: Cdp,
    ref: string,
    target: RefTarget,
    objectId: string,
    point: Point,
  ) {
    // Inside a frame the point is in the top page's coordinates; the
    // frame's own document can't hit-test it, so frames go unchecked.
    if (target.offsetFrom) return;
    const result = await callOn<{ ok: boolean; by?: string } | { skip: true }>(
      c,
      target.sessionId,
      objectId,
      `function (x, y) {
        const view = this.ownerDocument.defaultView;
        if (!view || view !== view.top) return { skip: true };
        let hit = this.ownerDocument.elementFromPoint(x, y);
        // Into shadow roots, to the element actually there.
        while (hit && hit.shadowRoot) {
          const inner = hit.shadowRoot.elementFromPoint(x, y);
          if (!inner || inner === hit) break;
          hit = inner;
        }
        if (!hit) return { skip: true };
        // An ancestor counts across shadow boundaries: a closed shadow root
        // stops the hit test at its host, which doesn't "contain" the button.
        const up = (n) => n.parentNode ?? n.host ?? null;
        let ancestor = false;
        for (let n = up(this); n && !ancestor; n = up(n)) ancestor = n === hit;
        const mine = hit === this || this.contains(hit) || ancestor ||
          (this.labels ? [...this.labels].some((label) => label.contains(hit)) : false);
        if (mine) return { ok: true };
        const named = hit.id ? \` id="\${hit.id}"\`
          : typeof hit.className === "string" && hit.className ? \` class="\${hit.className.slice(0, 40)}"\`
          : hit.getAttribute("aria-label") ? \` aria-label="\${hit.getAttribute("aria-label").slice(0, 40)}"\`
          : (hit.textContent || "").trim() ? \` "\${hit.textContent.trim().slice(0, 40)}"\` : "";
        return { ok: false, by: \`<\${hit.localName}\${named}>\` };
      }`,
      [point.x, point.y],
    ).catch(() => ({ skip: true as const }));
    if ("skip" in result || result.ok) return;
    throw new BrowserFailure(
      "invalid_request",
      `${ref} (${target.label}) is covered by ${result.by ?? "something"}.`,
      "Something is in front of it, like a banner or dialog: snapshot, close it, then try again (or click-xy if you're sure).",
    );
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
      world = await worldFor(entry, c, {
        sessionId,
        backendNodeId: 0,
        label: "",
      });
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

  /** Clicks a ref's element where a person would: its visible middle. */
  async function clickRef(
    entry: WindowEntry,
    c: Cdp,
    sessionId: string,
    ref: string,
  ) {
    const target = refTarget(entry, ref);
    const objectId = await objectFor(entry, c, ref, target);
    const point = await centerOf(c, ref, target);
    await checkNotCovered(c, ref, target, objectId, point);
    await clickAt(c, sessionId, point);
    return target;
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
        const world = await worldFor(entry, c, {
          sessionId,
          backendNodeId: 0,
          label: "",
        });
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

    click(runToken: string, ref: string, windowId?: string) {
      let label = "";
      return act(
        runToken,
        windowId,
        () => `Clicked ${ref} (${label}).`,
        async (entry, c, s) => {
          // Before clicking: a dialog the click opens ends the action early.
          label = refTarget(entry, ref).label;
          await clickRef(entry, c, s, ref);
        },
      );
    },

    type(
      runToken: string,
      ref: string,
      text: string,
      options: { clear?: boolean; submit?: boolean },
      windowId?: string,
    ) {
      let label = "";
      return act(
        runToken,
        windowId,
        () =>
          `Typed into ${ref} (${label})${options.submit ? " and pressed Enter" : ""}.`,
        async (entry, c, s) => {
          const target = refTarget(entry, ref);
          label = target.label;
          const objectId = await objectFor(entry, c, ref, target);
          // Click into it as a person would, then make sure it has focus.
          await clickRef(entry, c, s, ref);
          await c
            .send(
              "DOM.focus",
              { backendNodeId: target.backendNodeId },
              target.sessionId,
            )
            .catch(() => undefined);
          if (options.clear) {
            const selectAll = parseKey("Control+a");
            if (selectAll) await press(c, s, selectAll);
            await press(c, s, keys.Backspace);
          }
          await typeText(c, s, text);
          if (options.submit) await press(c, s, keys.Enter);
          const value = await callOn<string | null>(
            c,
            target.sessionId,
            objectId,
            "function () { return 'value' in this ? String(this.value) : (this.isContentEditable ? this.innerText : null); }",
          ).catch(() => null);
          if (
            value !== null &&
            !options.submit &&
            !value.includes(text.split("\n")[0] ?? "")
          )
            return `Its value is now "${value.slice(0, 80)}" (the page may have changed what was typed).`;
        },
      );
    },

    select(runToken: string, ref: string, option: string, windowId?: string) {
      return act(
        runToken,
        windowId,
        `Selected "${option}" in ${ref}.`,
        async (entry, c) => {
          const target = refTarget(entry, ref);
          const objectId = await objectFor(entry, c, ref, target);
          // A native <select> opens a popup input can't reach, so it's set the
          // way Playwright does: pick the option, then fire input and change.
          const result = await callOn<{
            ok: boolean;
            options?: string[];
            notSelect?: boolean;
          }>(
            c,
            target.sessionId,
            objectId,
            `function (wanted) {
            if (!(this instanceof HTMLSelectElement)) return { ok: false, notSelect: true };
            const opts = [...this.options];
            const norm = (s) => s.trim().toLowerCase();
            const w = norm(wanted);
            const found = opts.find((o) => norm(o.label) === w || norm(o.value) === w)
              ?? opts.find((o) => norm(o.label).includes(w));
            if (!found) return { ok: false, options: opts.map((o) => o.label.trim()).slice(0, 30) };
            this.focus();
            this.value = found.value;
            this.dispatchEvent(new Event("input", { bubbles: true }));
            this.dispatchEvent(new Event("change", { bubbles: true }));
            return { ok: true };
          }`,
            [option],
          );
          if (result.notSelect)
            throw new BrowserFailure(
              "invalid_request",
              `${ref} (${target.label}) isn't a native select.`,
              "Click it to open its list, snapshot, then click the option.",
            );
          if (!result.ok)
            throw new BrowserFailure(
              "invalid_request",
              `${ref} has no option "${option}".`,
              `Its options: ${(result.options ?? []).join(", ")}.`,
            );
        },
      );
    },

    press(runToken: string, key: string, windowId?: string) {
      const parsed = parseKey(key);
      if (!parsed)
        throw new BrowserFailure(
          "invalid_request",
          `"${key}" isn't a key winston browser press knows.`,
          `Use ${Object.keys(keys).join(", ")}, a single character, or a combination like Control+a.`,
        );
      return act(
        runToken,
        windowId,
        `Pressed ${key}.`,
        async (_entry, c, s) => {
          await press(c, s, parsed);
        },
      );
    },

    scroll(
      runToken: string,
      how: { to?: string | undefined; up?: boolean },
      windowId?: string,
    ) {
      return act(
        runToken,
        windowId,
        how.to
          ? `Scrolled ${how.to} into view.`
          : `Scrolled ${how.up ? "up" : "down"}.`,
        async (entry, c, s) => {
          if (how.to) {
            const target = refTarget(entry, how.to);
            await objectFor(entry, c, how.to, target);
            await centerOf(c, how.to, target);
            return;
          }
          const metrics = async () =>
            (
              await c.send<{
                cssVisualViewport: {
                  pageY: number;
                  clientHeight: number;
                  clientWidth: number;
                };
              }>("Page.getLayoutMetrics", {}, s)
            ).cssVisualViewport;
          const view = await metrics();
          await wheel(
            c,
            s,
            { x: view.clientWidth / 2, y: view.clientHeight / 2 },
            (how.up ? -1 : 1) * Math.round(view.clientHeight * 0.8),
          );
          await Bun.sleep(150);
          const after = await metrics();
          if (Math.abs(after.pageY - view.pageY) < 1)
            return how.up
              ? "Already at the top."
              : "Already at the bottom (or the page doesn't scroll there).";
        },
      );
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
      request: {
        text?: string | undefined;
        ref?: string | undefined;
        timeoutMs: number;
      },
      windowId?: string,
    ): Promise<BrowserActionResponse> {
      return act(
        runToken,
        windowId,
        (entry) => {
          if (request.text) return `"${request.text}" is on the page.`;
          if (request.ref) return `${request.ref} is visible.`;
          return entry.url ? "The page is settled." : "Done.";
        },
        async (entry, c, s) => {
          const deadline = core.now() + request.timeoutMs;
          const found = async () => {
            if (request.ref) {
              const target = refTarget(entry, request.ref);
              try {
                await objectFor(entry, c, request.ref, target);
                const { quads } = await c.send<{ quads: number[][] }>(
                  "DOM.getContentQuads",
                  { backendNodeId: target.backendNodeId },
                  target.sessionId,
                );
                return quads.length > 0;
              } catch {
                return false;
              }
            }
            if (request.text) {
              try {
                const world = await worldFor(entry, c, {
                  sessionId: s,
                  backendNodeId: 0,
                  label: "",
                });
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
                  : request.ref
                    ? `${request.ref} didn't become visible within ${String(Math.round(request.timeoutMs / 1000))} s.`
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
