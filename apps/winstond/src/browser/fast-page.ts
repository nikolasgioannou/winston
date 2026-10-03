/**
 * Autopilot's view of a page and its hands (docs/design.md §5, Jev fast
 * path), after browser-use/jev-ultrafast (MIT; read at commit 1231850).
 *
 * - **One atomic read** (`observe`): a single `Runtime.evaluate` returns the
 *   visible, enabled controls in the viewport, up to 6,000 characters of
 *   visible text, a marker of the page's meaning, and per-target guards.
 *   Each element gets a code-owned id, so the model never writes selectors,
 *   coordinates or code.
 * - **Freshness right before input** (`fresh`): a click or select checks its
 *   own guards (the document and URL, form values, the target, its nearby
 *   form, dialog or row text); anything else checks the whole marker.
 * - **Execution** (`act`): the target's geometry is read again, and a
 *   hidden, disabled, offscreen or covered target is refused, before any
 *   trusted input.
 *
 * Unlike jev-ultrafast, the scripts run in our isolated world, where the
 * page can't see their globals, and they walk open shadow roots. Frames
 * aren't read: controls inside one are counted and reported.
 */
import type { Cdp } from "./cdp.ts";
import { BrowserFailure, type WindowEntry } from "./state.ts";

/** One thing autopilot can do on the page: an element's operation, a scroll, or a wait. */
export interface FastAction {
  /** `e1`…, or `scroll_down`, `scroll_up`, `wait`. */
  id: string;
  kind: "click" | "fill" | "select" | "scroll" | "wait";
  label: string;
  /** The element's code-owned id (absent for scrolls and waits). */
  node?: number;
  role?: string;
  /** The field's value, or for a select, the option it would pick. */
  value?: string;
  /** A select's current choice. */
  current_value?: string;
  checked?: string;
  selected?: string;
  expanded?: string;
  /** Scroll distance in pixels. */
  delta?: number;
}

/** What one read of the page found. */
export interface FastPage {
  url: string;
  title: string;
  text: string;
  scroll: { y: number; height: number };
  actions: FastAction[];
  /** The page's meaning, to tell whether it changed. */
  marker: unknown;
  /** The document, URL, viewport and form values: part of every click's guard. */
  page_key: unknown;
  /** Per element: what must be unchanged for a click on it to still mean the same. */
  guards: Record<string, unknown>;
  /** Controls past the 250 sent. */
  omitted_actions: number;
  /** Visible frames autopilot can't look inside. */
  frames: number;
  /** A hash of what was seen, to tell whether an action changed anything. */
  fingerprint: string;
}

/** The page changed under a decision: observe again, and nothing was done. */
export class StalePage extends Error {}

/**
 * A confirm or prompt opened: Chrome holds every script and input until
 * it's answered, so the call gave up rather than wait.
 */
export class DialogOpen extends Error {}

/** Helpers both scripts share: shadow-aware ancestry, visibility, the hit test. */
const helpers = `
  const up = (n) => n.parentNode ?? n.host ?? null;
  const closestComposed = (e, selector) => {
    for (let n = e; n; n = up(n)) if (n.nodeType === 1 && n.matches(selector)) return n;
    return null;
  };
  const visible = (e) => !closestComposed(e, '[aria-hidden="true"],[inert]') &&
    e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  const hitAt = (x, y) => {
    let hit = document.elementFromPoint(x, y);
    while (hit && hit.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    return hit;
  };
  // A hit on the target, inside it, on a label of it, or on a composed
  // ancestor: a closed shadow root stops the hit test at its host.
  const reaches = (e, hit) => {
    if (!hit) return false;
    if (hit === e || e.contains(hit)) return true;
    for (let n = up(e); n; n = up(n)) if (n === hit) return true;
    return [...(e.labels || [])].some((label) => label.contains(hit));
  };
`;

/** The atomic read, after jev-ultrafast's `snapshot.js`. */
export const readState = `(() => {
  if (!document.body) return null;
  ${helpers}
  const cache = globalThis.__winstonFast ||= { ids: new WeakMap(), nodes: new Map(), next: 1 };
  const identity = (e) => {
    if (!cache.ids.has(e)) cache.ids.set(e, cache.next++);
    const id = cache.ids.get(e);
    cache.nodes.set(id, e);
    return id;
  };
  for (const [id, e] of cache.nodes) if (!e.isConnected) cache.nodes.delete(id);
  const safe = (e) => !['password', 'file', 'hidden'].includes(e.type);
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  const byId = (e, id) => e.getRootNode().getElementById?.(id) ?? document.getElementById(id);
  const name = (e, seen = new Set()) => {
    if (!e || seen.has(e)) return '';
    seen.add(e);
    const referenced = (e.getAttribute('aria-labelledby') || '').split(/\\s+/).filter(Boolean)
      .map((id) => name(byId(e, id), seen)).filter(Boolean).join(' ');
    const own = (node) => [...node.childNodes].map((n) => n.nodeType === 3 ? n.textContent :
      n.nodeType === 1 && n.getAttribute('aria-hidden') !== 'true' ? name(n, seen) : '').join(' ');
    const text = e.tagName === 'INPUT' ? '' : (own(e) + (e.shadowRoot ? ' ' + own(e.shadowRoot) : ''));
    return (referenced || e.getAttribute('aria-label') ||
      [...(e.labels || [])].map((l) => name(l, seen)).filter(Boolean).join(' ') ||
      (['button', 'submit', 'reset'].includes(e.type) ? e.value : '') || e.getAttribute('alt') ||
      text.replace(/\\s+/g, ' ').trim() ||
      e.getAttribute('title') || e.getAttribute('placeholder') || '').replace(/\\s+/g, ' ').trim();
  };
  const roles = ['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemradio',
    'option', 'gridcell', 'combobox', 'textbox', 'searchbox', 'spinbutton'];
  const selector = 'a[href],button,input,textarea,select,summary,[contenteditable="true"],' +
    roles.map((role) => '[role="' + role + '"]').join(',');
  const role = (e) => {
    const explicit = e.getAttribute('role');
    if (roles.includes(explicit)) return explicit;
    if (e.tagName === 'BUTTON' || e.tagName === 'SUMMARY') return 'button';
    if (e.tagName === 'A') return 'link';
    if (e.tagName === 'SELECT') return 'combobox';
    if (e.tagName === 'TEXTAREA' || e.isContentEditable) return 'textbox';
    if (e.tagName === 'INPUT') {
      if (['checkbox', 'radio'].includes(e.type)) return e.type;
      if (['button', 'submit', 'reset', 'image'].includes(e.type)) return 'button';
      if (e.type === 'search') return 'searchbox';
      if (e.type === 'number') return 'spinbutton';
      if (['text', 'email', 'url', 'tel', ''].includes(e.type)) return 'textbox';
    }
    return null;
  };
  // Everything in the document and its open shadow roots, in order.
  const each = (root, visit) => {
    for (const e of root.querySelectorAll('*')) {
      visit(e);
      if (e.shadowRoot) each(e.shadowRoot, visit);
    }
  };
  cache.pageKey = () => {
    const fields = [];
    each(document, (e) => { if (e.matches('input,textarea,select') && safe(e)) fields.push(e); });
    return [performance.timeOrigin, location.href, scrollX, scrollY, innerWidth, innerHeight,
      fields.map((e) => [identity(e), e.value, e.checked, e.selectedIndex, e.disabled, e.readOnly])];
  };
  cache.guard = (e) => {
    if (!e?.isConnected || !visible(e)) return null;
    const scope = e.closest('form,dialog,[role="dialog"],article,li,tr,[role="row"]') || e.parentElement;
    return [identity(e), role(e), name(e), e.value ?? null, e.checked ?? null, e.selectedIndex ?? null,
      e.readOnly ?? null, e.matches(':disabled'), e.getAttribute('aria-disabled'),
      e.getAttribute('aria-expanded'), e.getAttribute('aria-checked'), e.getAttribute('aria-selected'),
      e.getAttribute('href'), scope?.innerText?.slice(0, 6000) || ''];
  };
  const candidates = [];
  let frames = 0;
  const inView = (r) => r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight &&
    r.right > 0 && r.left < innerWidth;
  each(document, (e) => {
    if (e.matches(selector)) candidates.push(e);
    else if (e.tagName === 'IFRAME') {
      const r = e.getBoundingClientRect();
      if (r.width * r.height > 5000 && inView(r) && visible(e)) frames += 1;
    }
  });
  const actions = [];
  for (const e of candidates) {
    if (!safe(e) || !visible(e) || e.matches(':disabled') || closestComposed(e, '[aria-disabled="true"]')) continue;
    const r = e.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2, rname = role(e);
    if (!rname || r.width <= 0 || r.height <= 0 || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
    if (rname === 'gridcell' && e.querySelector('button,[role="button"]')) continue;
    const base = { node: identity(e), role: rname, label: clip(name(e) || rname, 160) };
    for (const key of ['checked', 'selected', 'expanded']) {
      const value = e.getAttribute('aria-' + key);
      if (value !== null) base[key] = value;
    }
    if (['checkbox', 'radio'].includes(e.type)) base.checked = String(e.checked);
    if (e.tagName === 'SELECT') {
      for (const o of e.options) if (!o.selected && !o.disabled && !o.closest('optgroup[disabled]'))
        actions.push({ ...base, kind: 'select', value: o.value,
          current_value: clip([...e.selectedOptions].map((s) => s.label).join(', '), 160),
          label: base.label + ' → ' + clip(o.label, 80) });
    } else {
      const editable = !e.readOnly && e.getAttribute('aria-readonly') !== 'true' &&
        (['textbox', 'searchbox', 'spinbutton'].includes(rname) ||
          (rname === 'combobox' && ['INPUT', 'TEXTAREA'].includes(e.tagName)));
      const value = clip('value' in e ? String(e.value) :
        e.isContentEditable || rname === 'combobox' ? e.innerText.trim() : '', 300);
      actions.push({ ...base, kind: editable ? 'fill' : 'click', value });
      if (editable) actions.push({ ...base, kind: 'click', value, label: 'Open ' + base.label });
    }
  }
  const words = [], range = document.createRange();
  let length = 0;
  const readText = (root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode()) && length < 6000) {
      if (node.nodeType === 1) {
        if (node.shadowRoot) readText(node.shadowRoot);
        continue;
      }
      const value = node.textContent.trim(), parent = node.parentElement;
      if (!value || !parent || parent.closest('script,style,noscript,template') || !visible(parent)) continue;
      range.selectNodeContents(node);
      if (inView(range.getBoundingClientRect())) {
        words.push(value);
        length += value.length;
      }
    }
  };
  readText(document.body);
  const text = words.join('\\n').slice(0, 6000), height = document.documentElement.scrollHeight;
  const page_key = cache.pageKey(), guards = {};
  for (const a of actions) if (!(a.node in guards)) guards[a.node] = cache.guard(cache.nodes.get(a.node));
  // Meaning and identity; geometry is read again right before input.
  const marker = [performance.timeOrigin, location.href, scrollX, scrollY, innerWidth, innerHeight,
    document.title, text, actions.map((a) => ({ ...a })), page_key[6]];
  const omitted_actions = Math.max(0, actions.length - 250);
  actions.splice(250);
  actions.forEach((a, i) => { a.id = 'e' + (i + 1); });
  const step = Math.round(innerHeight * 0.7);
  if (scrollY + innerHeight < height - 2) actions.push({ id: 'scroll_down', kind: 'scroll', label: 'Scroll down', delta: step });
  if (scrollY > 0) actions.push({ id: 'scroll_up', kind: 'scroll', label: 'Scroll up', delta: -step });
  actions.push({ id: 'wait', kind: 'wait', label: 'Wait for the page to update' });
  return { url: location.href, title: document.title, text, scroll: { y: scrollY, height },
    actions, marker, page_key, guards, omitted_actions, frames };
})()`;

/** Just the marker, from a fresh full read. */
const readMarker = `(() => { const state = ${readState}; return state ? state.marker : null; })()`;

/** A click's or select's own guards, now. */
const readGuard = (node: number) =>
  `(() => { const c = globalThis.__winstonFast; return c ? [c.pageKey(), c.guard(c.nodes.get(${String(node)}))] : null; })()`;

/**
 * Checks the target right before input, and does a select in place.
 * Returns the point to click, or null if the target is gone, hidden,
 * disabled, offscreen or covered.
 */
const checkTarget = (action: FastAction) => `((action) => {
  ${helpers}
  const e = globalThis.__winstonFast?.nodes.get(action.node);
  if (!e?.isConnected || e.matches(':disabled') || closestComposed(e, '[aria-disabled="true"],[inert]') ||
      !e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return null;
  if (action.kind === 'fill' && (e.readOnly || e.getAttribute('aria-readonly') === 'true')) return null;
  const r = e.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
  if (!r.width || !r.height || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return null;
  if (!reaches(e, hitAt(x, y))) return null;
  if (action.kind === 'select') {
    if (e.tagName !== 'SELECT' || ![...e.options].some((o) => o.value === action.value &&
        !o.disabled && !o.closest('optgroup[disabled]'))) return null;
    e.value = action.value;
    e.dispatchEvent(new Event('input', { bubbles: true }));
    e.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return { x, y };
})(${JSON.stringify({ node: action.node, kind: action.kind, value: action.value })})`;

/**
 * After input: at most two animation frames or 50 ms; after typing into a
 * combobox, until its options show, at most 200 ms.
 */
const afterInput = (
  action: FastAction,
) => `((action) => new Promise((resolve) => {
  const field = globalThis.__winstonFast?.nodes.get(action.node);
  const autocomplete = action.kind === 'fill' && field?.getAttribute('role') === 'combobox';
  let frames = 0, stopped = false;
  const finish = () => { stopped = true; resolve(true); };
  setTimeout(finish, autocomplete ? 200 : 50);
  const ready = () => {
    if (stopped) return;
    const ids = (field?.getAttribute('aria-controls') || field?.getAttribute('aria-owns') || '')
      .split(/\\s+/).filter(Boolean);
    const roots = ids.length ? ids.map((id) => document.getElementById(id)).filter(Boolean) : [document];
    const options = roots.flatMap((root) => [...root.querySelectorAll('[role="option"]')]);
    if (++frames >= 2 && (!autocomplete || options.some((e) => {
      const r = e.getBoundingClientRect();
      return r.width && r.height && r.bottom > 0 && r.top < innerHeight &&
        e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    }))) finish();
    else requestAnimationFrame(ready);
  };
  requestAnimationFrame(ready);
}))(${JSON.stringify({ node: action.node, kind: action.kind })})`;

/** A hash of what was seen: whether an action changed the page. */
export function fingerprint(
  page: Pick<FastPage, "url" | "text" | "actions" | "scroll">,
) {
  return new Bun.CryptoHasher("sha256")
    .update(
      JSON.stringify({
        actions: page.actions,
        scroll: page.scroll,
        text: page.text,
        url: page.url,
      }),
    )
    .digest("hex");
}

/** Two results of the scripts, compared as the JSON they came back as. */
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

/** The CDP access a fast page needs. */
export interface FastPageDeps {
  sessionFor: (entry: WindowEntry) => Promise<{ c: Cdp; sessionId: string }>;
  sleep?: (ms: number) => Promise<unknown>;
}

export function fastPage(deps: FastPageDeps) {
  const sleep = deps.sleep ?? Bun.sleep;

  /** A CDP call that gives up when a dialog opens. */
  async function unlessDialog<T>(entry: WindowEntry, call: Promise<T>) {
    call.catch(() => undefined);
    const watch = { on: true };
    const opened = (async () => {
      while (watch.on && !entry.dialog) await sleep(50);
      if (watch.on) throw new DialogOpen("The page opened a dialog.");
      return undefined as never;
    })();
    try {
      return await Promise.race([call, opened]);
    } finally {
      watch.on = false;
    }
  }

  /** A call in the window's page session, giving up if a dialog opens. */
  async function send<T>(
    entry: WindowEntry,
    method: string,
    params: Record<string, unknown>,
  ) {
    const { c, sessionId } = await deps.sessionFor(entry);
    return unlessDialog(entry, c.send<T>(method, params, sessionId));
  }

  /** The isolated world for the window's main frame, made once per document. */
  async function world(entry: WindowEntry, c: Cdp, sessionId: string) {
    const { frameTree } = await c.send<{
      frameTree: { frame: { id: string } };
    }>("Page.getFrameTree", {}, sessionId);
    const key = `${sessionId}:${frameTree.frame.id}`;
    const known = entry.worlds.get(key);
    if (known !== undefined) return { key, contextId: known };
    const { executionContextId } = await c.send<{
      executionContextId: number;
    }>(
      "Page.createIsolatedWorld",
      { frameId: frameTree.frame.id, worldName: "winston" },
      sessionId,
    );
    entry.worlds.set(key, executionContextId);
    return { key, contextId: executionContextId };
  }

  /**
   * Runs a script in the isolated world: its value, or a `StalePage` when
   * the document changed under it (the world went with the old document).
   */
  async function evaluate<T>(
    entry: WindowEntry,
    expression: string,
    options: { awaitPromise?: boolean } = {},
  ): Promise<T> {
    const { c, sessionId } = await deps.sessionFor(entry);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { key, contextId } = await world(entry, c, sessionId);
      let response: {
        result?: { value?: unknown };
        exceptionDetails?: { text: string };
      };
      try {
        response = await unlessDialog(
          entry,
          c.send(
            "Runtime.evaluate",
            {
              expression,
              contextId,
              returnByValue: true,
              awaitPromise: options.awaitPromise === true,
            },
            sessionId,
          ),
        );
      } catch (error) {
        if (error instanceof DialogOpen) throw error;
        // A world from a document that's gone: make a new one, once.
        entry.worlds.delete(key);
        continue;
      }
      if (response.exceptionDetails)
        throw new StalePage("The document changed during the read.");
      return response.result?.value as T;
    }
    throw new StalePage("The document changed during the read.");
  }

  return {
    /** One atomic read of the page, retried briefly while a document is swapping in. */
    async observe(entry: WindowEntry): Promise<FastPage> {
      for (let attempt = 0; ; attempt += 1) {
        try {
          const state = await evaluate<Omit<FastPage, "fingerprint"> | null>(
            entry,
            readState,
          );
          if (!state) throw new StalePage("The document is loading.");
          return { ...state, fingerprint: fingerprint(state) };
        } catch (error) {
          if (!(error instanceof StalePage) || attempt >= 9) throw error;
          await sleep(20);
        }
      }
    },

    /** Whether the page still means what it did for `action` (or at all, without one). */
    async fresh(entry: WindowEntry, page: FastPage, action?: FastAction) {
      if (
        action?.node !== undefined &&
        (action.kind === "click" || action.kind === "select")
      ) {
        const now = await evaluate(entry, readGuard(action.node));
        return same(now, [page.page_key, page.guards[String(action.node)]]);
      }
      return same(await evaluate(entry, readMarker), page.marker);
    },

    /**
     * Does `action`, after checking right before input that the page is
     * still the one decided on. A select that may have half happened is
     * never reported stale (it can't be retried blindly).
     */
    async act(
      entry: WindowEntry,
      page: FastPage,
      action: FastAction,
      text?: string,
    ) {
      if (!(await this.fresh(entry, page, action)))
        throw new StalePage("The page changed since this decision.");
      if (action.kind === "wait") {
        await sleep(100);
        return;
      }
      if (action.kind === "scroll") {
        const { cssVisualViewport } = await send<{
          cssVisualViewport: { clientWidth: number; clientHeight: number };
        }>(entry, "Page.getLayoutMetrics", {});
        await send(entry, "Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: cssVisualViewport.clientWidth / 2,
          y: cssVisualViewport.clientHeight / 2,
          deltaX: 0,
          deltaY: action.delta ?? 0,
        });
        return;
      }
      let point: { x: number; y: number } | null;
      try {
        point = await evaluate<{ x: number; y: number } | null>(
          entry,
          checkTarget(action),
        );
      } catch (error) {
        if (action.kind === "select" && !(error instanceof DialogOpen))
          throw new BrowserFailure(
            "internal",
            "The dropdown change was interrupted; look before trying again.",
          );
        throw error;
      }
      if (!point) {
        if (action.kind === "select")
          throw new BrowserFailure(
            "internal",
            "The dropdown change wasn't confirmed; look before trying again.",
          );
        throw new StalePage("The target changed or is covered.");
      }
      if (action.kind === "select") return;
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
        await send(entry, "Input.dispatchMouseEvent", {
          type,
          ...point,
          ...(type === "mouseMoved"
            ? {}
            : {
                button: "left",
                buttons: type === "mousePressed" ? 1 : 0,
                clickCount: 1,
              }),
        });
      if (action.kind === "fill") {
        // Select all (Ctrl on the VM's Linux), then type over it.
        const key = { key: "a", code: "KeyA", modifiers: 2 };
        await send(entry, "Input.dispatchKeyEvent", {
          type: "keyDown",
          ...key,
          commands: ["selectAll"],
        });
        await send(entry, "Input.dispatchKeyEvent", { type: "keyUp", ...key });
        await send(entry, "Input.insertText", { text: text ?? "" });
      }
    },

    /** Waits briefly for the page to react to an action (read-only; failures are fine). */
    async settle(entry: WindowEntry, action: FastAction) {
      if (action.kind === "wait" || action.node === undefined) return;
      await evaluate(entry, afterInput(action), { awaitPromise: true }).catch(
        () => undefined,
      );
    },
  };
}

export type FastPageReader = ReturnType<typeof fastPage>;
