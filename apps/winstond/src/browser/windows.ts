/**
 * Agent windows in the shared Chrome profile (docs/design.md §5 Browser):
 * every run drives its own window, created with `Target.createTarget` and
 * `newWindow`, so none is a background tab Chrome would throttle. winstond
 * keeps the registry, since the CLI exits after every command.
 *
 * Ownership comes from the run token the CLI sends: the front of house owns
 * its windows across turns (`front`), a background run by its run id. It's
 * coordination between agents that all run as `winston` (who can reach
 * Chrome's DevTools anyway), not a security boundary, so the token's payload
 * is read without its signature, which only the backend can check.
 *
 * Nothing here calls `Runtime.enable`, which pages can detect.
 */
import type {
  BrowserCloseResponse,
  BrowserPageResponse,
  BrowserSnapshotResponse,
  BrowserWindowInfo,
} from "@winston/domain/browser";
import { createId } from "@winston/shared/ids";
import type { Cdp, CdpEvent } from "./cdp.ts";
import { createActions } from "./actions.ts";
import { createLocks } from "./locks.ts";
import { formatSnapshot, readFrames } from "./snapshot.ts";
import { BrowserFailure, browserTimings, type WindowEntry } from "./state.ts";

export { BrowserFailure, browserTimings };

interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
  title: string;
  openerId?: string;
}

/** The owner a run token names: `front`, or the background run's id. */
export function ownerOf(runToken: string): { owner: string; exp: number } {
  const [body] = runToken.split(".");
  try {
    const payload = JSON.parse(
      Buffer.from(body ?? "", "base64url").toString(),
    ) as { runId?: unknown; kind?: unknown; exp?: unknown };
    if (typeof payload.runId === "string" && typeof payload.exp === "number")
      return {
        owner: payload.kind === "front" ? "front" : payload.runId,
        exp: payload.exp,
      };
  } catch {
    // Falls through to the failure below.
  }
  throw new BrowserFailure(
    "unauthorized",
    "Browser commands need your run's token.",
    "Run them from your bash tool, where WINSTON_RUN_TOKEN is set.",
  );
}

/** A URL as typed: `example.com` means https. */
export function normalizeUrl(url: string) {
  const trimmed = url.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

export interface BrowserDeps {
  /** Opens a CDP connection to Chrome's browser target. */
  connect: () => Promise<Cdp>;
  downloadPath?: string;
  now?: () => number;
  /** Saves a file in Winston's home, as winston (screenshots). */
  saveFile?: (path: string, bytes: Uint8Array) => Promise<void>;
}

export type Browser = ReturnType<typeof createBrowser>;

export function createBrowser(deps: BrowserDeps) {
  const now = deps.now ?? Date.now;
  const windows = new Map<string, WindowEntry>();
  const byTarget = new Map<string, string>();
  /** Each owner's current window: where commands without --window act. */
  const current = new Map<string, string>();
  /** Windows, and owners, whose windows a Chrome restart closed. */
  const lostWindows = new Set<string>();
  const lostOwners = new Set<string>();
  /** The latest run-token expiry seen per owner (its run is alive until then). */
  const ownerExp = new Map<string, number>();
  let cdp: Cdp | undefined;
  let connecting: Promise<Cdp> | undefined;

  const locks = createLocks(now);

  const info = (entry: WindowEntry, owner: string): BrowserWindowInfo => ({
    id: entry.id,
    owner: entry.owner,
    url: entry.url,
    title: entry.title,
    openedBy: entry.openedBy,
    current: current.get(owner) === entry.id,
    mine: entry.owner === owner,
    locks: locks.heldFrom(entry.id),
  });

  /** A run with no windows left gives up its sites. */
  const releaseIfGone = (owner: string) => {
    if (![...windows.values()].some((entry) => entry.owner === owner))
      locks.release(owner);
  };

  /** The owner's newest remaining window, after its current one goes. */
  function pickCurrent(owner: string) {
    const mine = [...windows.values()]
      .filter((entry) => entry.owner === owner)
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    if (mine[0]) current.set(owner, mine[0].id);
    else current.delete(owner);
  }

  function forget(entry: WindowEntry) {
    windows.delete(entry.id);
    byTarget.delete(entry.targetId);
    if (current.get(entry.owner) === entry.id) pickCurrent(entry.owner);
    releaseIfGone(entry.owner);
  }

  function register(
    target: TargetInfo,
    owner: string,
    openedBy: string | null,
  ) {
    const entry: WindowEntry = {
      id: createId("win"),
      targetId: target.targetId,
      owner,
      openedBy,
      url: target.url,
      title: target.title,
      createdAt: now(),
      lastUsedAt: now(),
      frames: new Map(),
      refs: new Map(),
      refByNode: new Map(),
      nextRef: 1,
      lastNetwork: 0,
      loadingFrames: new Set(),
      handledDialogs: [],
      worlds: new Map(),
      heldForUser: false,
    };
    windows.set(entry.id, entry);
    byTarget.set(entry.targetId, entry.id);
    current.set(owner, entry.id);
    return entry;
  }

  /** The window a page-level event belongs to (its page or one of its frames). */
  const windowOfSession = (sessionId: string | undefined) =>
    sessionId === undefined
      ? undefined
      : [...windows.values()].find(
          (entry) =>
            entry.sessionId === sessionId ||
            [...entry.frames.values()].includes(sessionId),
        );

  function onPageEvent(event: CdpEvent) {
    const entry = windowOfSession(event.sessionId);
    if (!entry) return;
    switch (event.method) {
      case "Network.requestWillBeSent":
      case "Network.loadingFinished":
      case "Network.loadingFailed":
        entry.lastNetwork = now();
        return;
      case "Page.frameStartedLoading":
        entry.loadingFrames.add(String(event.params.frameId));
        return;
      case "Page.frameStoppedLoading":
        entry.loadingFrames.delete(String(event.params.frameId));
        return;
      case "Page.javascriptDialogOpening": {
        const type = String(event.params.type);
        const text = (value: unknown) =>
          typeof value === "string" ? value : "";
        const message = text(event.params.message);
        // Alerts need no decision, and leaving the page is what the agent
        // asked for; answering them keeps the page from hanging.
        if (type === "alert" || type === "beforeunload") {
          entry.handledDialogs.push(
            type === "alert"
              ? `The page showed an alert: "${message}" (dismissed).`
              : "The page asked to confirm leaving it (allowed).",
          );
          void cdp
            ?.send(
              "Page.handleJavaScriptDialog",
              { accept: true },
              event.sessionId,
            )
            .catch(() => undefined);
          return;
        }
        entry.dialog = {
          type,
          message,
          defaultPrompt: text(event.params.defaultPrompt),
        };
        return;
      }
      case "Page.javascriptDialogClosed":
        entry.dialog = undefined;
        return;
      default:
        return;
    }
  }

  function onEvent(event: CdpEvent) {
    onPageEvent(event);
    const target = event.params.targetInfo as TargetInfo | undefined;
    switch (event.method) {
      case "Target.targetCreated": {
        // A page opened by one of ours (window.open, target=_blank) belongs
        // to the same run and becomes its current window.
        if (target?.type !== "page" || !target.openerId) return;
        if (byTarget.has(target.targetId)) return;
        const openerId = byTarget.get(target.openerId);
        const opener = openerId ? windows.get(openerId) : undefined;
        if (opener) register(target, opener.owner, opener.id);
        return;
      }
      case "Target.targetInfoChanged": {
        const id = target ? byTarget.get(target.targetId) : undefined;
        const entry = id ? windows.get(id) : undefined;
        if (entry && target) {
          entry.url = target.url;
          entry.title = target.title;
        }
        return;
      }
      case "Target.targetDestroyed": {
        const id = byTarget.get(String(event.params.targetId));
        const entry = id ? windows.get(id) : undefined;
        if (entry) forget(entry);
        return;
      }
      case "Page.frameNavigated": {
        // A new document in a window: its node ids mean nothing any more
        // (Chrome reuses them across sites), so it gets fresh refs. Numbers
        // keep counting up, so a ref never names two elements in a window.
        const frame = event.params.frame as
          { id?: string; parentId?: string } | undefined;
        const entry = windowOfSession(event.sessionId);
        // The frame's isolated world went with its old document.
        if (entry && frame?.id)
          entry.worlds.delete(`${String(event.sessionId)}:${frame.id}`);
        if (frame?.parentId !== undefined) return;
        if (entry && entry.sessionId === event.sessionId) {
          entry.refByNode.clear();
          entry.refs.clear();
          entry.worlds.clear();
        }
        return;
      }
      case "Target.attachedToTarget": {
        // A cross-site frame in one of our pages (auto-attach).
        const child = event.params.targetInfo as TargetInfo | undefined;
        if (child?.type !== "iframe") return;
        for (const entry of windows.values())
          if (entry.sessionId === event.sessionId)
            entry.frames.set(child.targetId, String(event.params.sessionId));
        return;
      }
      case "Target.detachedFromTarget": {
        for (const entry of windows.values()) {
          if (entry.sessionId === event.params.sessionId)
            delete entry.sessionId;
          entry.frames.delete(String(event.params.targetId));
        }
        return;
      }
      default:
        return;
    }
  }

  async function connection() {
    if (cdp) return cdp;
    connecting ??= (async () => {
      let opened: Cdp;
      try {
        opened = await deps.connect();
      } catch {
        throw new BrowserFailure(
          "unavailable",
          "Chrome isn't answering.",
          "It restarts by itself; try again in a minute.",
        );
      }
      opened.on(onEvent);
      await opened.send("Target.setDiscoverTargets", { discover: true });
      await opened.send("Browser.setDownloadBehavior", {
        behavior: "allow",
        downloadPath: deps.downloadPath ?? "/home/winston/downloads",
      });
      void opened.closed.then(() => {
        if (cdp !== opened) return;
        // Chrome went away (and systemd brings it back): every window is gone.
        cdp = undefined;
        for (const entry of windows.values()) {
          lostWindows.add(entry.id);
          lostOwners.add(entry.owner);
        }
        const owners = new Set([...windows.values()].map((e) => e.owner));
        windows.clear();
        for (const owner of owners) locks.release(owner);
        byTarget.clear();
        current.clear();
      });
      cdp = opened;
      return opened;
    })().finally(() => {
      connecting = undefined;
    });
    return connecting;
  }

  const restarted = () =>
    new BrowserFailure(
      "not_found",
      "Chrome restarted, so your window was closed.",
      "Open a new one with winston browser open <url> and carry on from there.",
    );

  /** The window a command acts on: --window, or the owner's current one. */
  function windowFor(
    owner: string,
    windowId: string | undefined,
    access: "own" | "look",
  ) {
    if (windowId) {
      const entry = windows.get(windowId);
      if (!entry) {
        if (lostWindows.has(windowId)) throw restarted();
        throw new BrowserFailure(
          "not_found",
          `There's no window ${windowId}.`,
          "winston browser windows lists them.",
        );
      }
      if (access === "own" && entry.heldForUser)
        throw new BrowserFailure(
          "invalid_request",
          `You handed ${windowId} to the user; it's theirs until they're done.`,
          "Wait for them, or open another window for something else.",
        );
      if (access === "own" && entry.owner !== owner)
        throw new BrowserFailure(
          "invalid_request",
          `${windowId} belongs to another task.`,
          "You can look at it (snapshot, screenshot) but not act in it. Open your own with winston browser open <url>.",
        );
      return entry;
    }
    const id = current.get(owner);
    const entry = id ? windows.get(id) : undefined;
    if (entry?.heldForUser && access === "own")
      throw new BrowserFailure(
        "invalid_request",
        `You handed ${entry.id} to the user; it's theirs until they're done.`,
        "Wait for them, or open another window for something else.",
      );
    if (entry) return entry;
    if (lostOwners.delete(owner)) throw restarted();
    throw new BrowserFailure(
      "not_found",
      "You don't have a browser window yet.",
      "Open one with winston browser open <url>.",
    );
  }

  async function sessionFor(entry: WindowEntry) {
    const c = await connection();
    if (entry.sessionId) return { c, sessionId: entry.sessionId };
    const { sessionId } = await c.send<{ sessionId: string }>(
      "Target.attachToTarget",
      { targetId: entry.targetId, flatten: true },
    );
    entry.sessionId = sessionId;
    await c.send("Page.enable", {}, sessionId);
    await c.send(
      "Page.setLifecycleEventsEnabled",
      { enabled: true },
      sessionId,
    );
    // Requests tell when a page has settled after an action.
    await c.send("Network.enable", {}, sessionId);
    // Cross-site frames get sessions of their own, for snapshots and actions.
    await c.send(
      "Target.setAutoAttach",
      { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
      sessionId,
    );
    return { c, sessionId };
  }

  /** Records matching events from now on, so none is missed while a command runs. */
  function recordEvents(c: Cdp, matches: (event: CdpEvent) => boolean) {
    const seen: CdpEvent[] = [];
    let wake: (() => void) | undefined;
    const stop = c.on((event) => {
      if (!matches(event)) return;
      seen.push(event);
      wake?.();
    });
    return {
      /** Waits until `found` holds for an event seen; false on timeout. */
      async until(found: (event: CdpEvent) => boolean, timeoutMs: number) {
        const deadline = now() + timeoutMs;
        for (;;) {
          if (seen.some(found)) return true;
          const left = deadline - now();
          if (left <= 0) return false;
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, left);
            wake = () => {
              clearTimeout(timer);
              resolve();
            };
          });
        }
      },
      stop,
    };
  }

  async function refresh(entry: WindowEntry) {
    const c = await connection();
    const { targetInfo } = await c.send<{ targetInfo: TargetInfo }>(
      "Target.getTargetInfo",
      { targetId: entry.targetId },
    );
    entry.url = targetInfo.url;
    entry.title = targetInfo.title;
  }

  async function navigateTo(entry: WindowEntry, url: string) {
    const { c, sessionId } = await sessionFor(entry);
    const lifecycle = recordEvents(
      c,
      (e) => e.sessionId === sessionId && e.method === "Page.lifecycleEvent",
    );
    try {
      const result = await c.send<{
        frameId: string;
        loaderId?: string;
        errorText?: string;
      }>("Page.navigate", { url: normalizeUrl(url) }, sessionId);
      // A download aborts the navigation but isn't a failure.
      if (result.errorText && result.errorText !== "net::ERR_ABORTED")
        throw new BrowserFailure(
          "invalid_request",
          `Couldn't load ${url}: ${result.errorText}.`,
          "Check the address, or try again if the site is down.",
        );
      // No loader means it stayed on the same document (a #fragment).
      if (!result.loaderId) return true;
      const ofThisLoad = (name: string) => (e: CdpEvent) =>
        e.params.loaderId === result.loaderId && e.params.name === name;
      const loaded = await lifecycle.until(
        ofThisLoad("load"),
        browserTimings.loadTimeoutMs,
      );
      if (loaded)
        await lifecycle.until(
          ofThisLoad("networkAlmostIdle"),
          browserTimings.settleMs,
        );
      return loaded;
    } finally {
      lifecycle.stop();
    }
  }

  async function goThroughHistory(
    entry: WindowEntry,
    step: -1 | 1,
    lock: (url: string) => unknown,
  ) {
    const { c, sessionId } = await sessionFor(entry);
    const history = await c.send<{
      currentIndex: number;
      entries: { id: number; url: string }[];
    }>("Page.getNavigationHistory", {}, sessionId);
    const to = history.entries[history.currentIndex + step];
    if (!to)
      throw new BrowserFailure(
        "invalid_request",
        step < 0
          ? "There's no page to go back to."
          : "There's no page to go forward to.",
      );
    lock(to.url);
    const events = recordEvents(
      c,
      (e) =>
        e.sessionId === sessionId &&
        (e.method === "Page.lifecycleEvent" ||
          e.method === "Page.frameNavigated"),
    );
    try {
      await c.send(
        "Page.navigateToHistoryEntry",
        { entryId: to.id },
        sessionId,
      );
      // A page restored from the back/forward cache fires no load event.
      return await events.until(
        (e) =>
          (e.method === "Page.lifecycleEvent" && e.params.name === "load") ||
          (e.method === "Page.frameNavigated" &&
            e.params.type === "BackForwardCacheRestore"),
        browserTimings.loadTimeoutMs,
      );
    } finally {
      events.stop();
    }
  }

  /** Runs a page command, then reports the window and anything it opened. */
  async function pageCommand(
    owner: string,
    entry: WindowEntry,
    run: () => Promise<boolean>,
  ): Promise<BrowserPageResponse> {
    const started = now();
    entry.lastUsedAt = started;
    const loaded = await run();
    if (windows.has(entry.id)) await refresh(entry);
    const opened = [...windows.values()].filter(
      (other) =>
        other.owner === owner &&
        other.openedBy !== null &&
        other.createdAt >= started,
    );
    const shown = windows.has(entry.id)
      ? entry
      : (windows.get(current.get(owner) ?? "") ?? entry);
    return {
      window: info(shown, owner),
      loaded,
      opened: opened.map((other) => info(other, owner)),
    };
  }

  /** Notes the run behind a token is alive, and returns its owner. */
  function caller(runToken: string) {
    const { owner, exp } = ownerOf(runToken);
    ownerExp.set(owner, Math.max(exp, ownerExp.get(owner) ?? 0));
    return owner;
  }

  const actions = createActions({
    caller,
    windowFor,
    sessionFor,
    refresh,
    info,
    allWindows: () => [...windows.values()],
    currentOf: (owner) => current.get(owner),
    now,
    lock: (owner, entry) => locks.acquire(entry.url, owner, entry.id),
    saveFile:
      deps.saveFile ??
      (() => Promise.reject(new Error("This browser can't save files."))),
  });

  return {
    ...actions,

    async windows(runToken: string) {
      const owner = caller(runToken);
      await connection();
      return [...windows.values()]
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((entry) => info(entry, owner));
    },

    async window(runToken: string, windowId: string) {
      const owner = caller(runToken);
      await connection();
      return info(windowFor(owner, windowId, "look"), owner);
    },

    async open(runToken: string, url?: string) {
      const owner = caller(runToken);
      const c = await connection();
      // A blank window first, then navigate once attached, so the load is seen.
      const { targetId } = await c.send<{ targetId: string }>(
        "Target.createTarget",
        { url: "about:blank", newWindow: true },
      );
      const entry = register(
        { targetId, type: "page", url: "about:blank", title: "" },
        owner,
        null,
      );
      lostOwners.delete(owner);
      if (url) locks.acquire(normalizeUrl(url), owner, entry.id);
      return pageCommand(owner, entry, () =>
        url ? navigateTo(entry, url) : Promise.resolve(true),
      );
    },

    async navigate(
      runToken: string,
      request: { url?: string | undefined; back?: boolean; forward?: boolean },
      windowId?: string,
    ) {
      const owner = caller(runToken);
      await connection();
      const entry = windowFor(owner, windowId, "own");
      if (request.url)
        locks.acquire(normalizeUrl(request.url), owner, entry.id);
      return pageCommand(owner, entry, () =>
        request.url
          ? navigateTo(entry, request.url)
          : goThroughHistory(entry, request.back ? -1 : 1, (url) =>
              locks.acquire(url, owner, entry.id),
            ),
      );
    },

    async close(
      runToken: string,
      windowId?: string,
    ): Promise<BrowserCloseResponse> {
      const owner = caller(runToken);
      const c = await connection();
      const entry = windowFor(owner, windowId, "own");
      await c.send("Target.closeTarget", { targetId: entry.targetId });
      forget(entry);
      return { closed: entry.id, current: current.get(owner) ?? null };
    },

    async snapshot(
      runToken: string,
      request: { window?: string | undefined; full?: boolean },
    ): Promise<BrowserSnapshotResponse> {
      const owner = caller(runToken);
      await connection();
      const entry = windowFor(owner, request.window, "look");
      const own = entry.owner === owner;
      if (own) entry.lastUsedAt = now();
      const { c, sessionId } = await sessionFor(entry);
      const frames = await readFrames(c, sessionId, entry.frames);
      const { lines, refs } = formatSnapshot(frames, {
        full: request.full === true,
        refs: own,
        refFor: (target) => {
          const key = `${target.sessionId}:${String(target.backendNodeId)}`;
          let ref = entry.refByNode.get(key);
          if (!ref) {
            ref = `e${String(entry.nextRef++)}`;
            entry.refByNode.set(key, ref);
          }
          return ref;
        },
      });
      // A peek leaves the owner's refs alone.
      if (own) entry.refs = refs;
      await refresh(entry);
      const cap = request.full
        ? browserTimings.fullSnapshotLines
        : browserTimings.snapshotLines;
      return {
        window: info(entry, owner),
        lines: lines.slice(0, cap),
        more: Math.max(0, lines.length - cap),
        readOnly: !own,
      };
    },

    /**
     * Hands an owner's current window to the user (a handoff): the agent
     * can't act in it, and its site locks stay put, until `release`. Null
     * when the owner has no window.
     */
    hold(owner: string) {
      const id = current.get(owner);
      const entry = id ? windows.get(id) : undefined;
      if (!entry) return null;
      entry.heldForUser = true;
      entry.lastUsedAt = now();
      locks.pin(owner);
      return { windowId: entry.id, targetId: entry.targetId, url: entry.url };
    },

    /** The user is done: the owner's windows are its own again. */
    release(owner: string) {
      for (const entry of windows.values())
        if (entry.owner === owner && entry.heldForUser) {
          entry.heldForUser = false;
          entry.lastUsedAt = now();
        }
      locks.unpin(owner);
    },

    /** The CDP connection, for the live view (screencast.ts). */
    connection,

    /** Whether any window is open (its run's state lives only in memory). */
    hasWindows: () => windows.size > 0,

    /** Closes windows left by runs that have ended (idle, token expired). */
    async sweep() {
      const at = now();
      const stale = [...windows.values()].filter(
        (entry) =>
          !entry.heldForUser &&
          at - entry.lastUsedAt > browserTimings.idleMs &&
          at > (ownerExp.get(entry.owner) ?? 0),
      );
      for (const entry of stale) {
        forget(entry);
        await cdp
          ?.send("Target.closeTarget", { targetId: entry.targetId })
          .catch(() => undefined);
      }
      return stale.map((entry) => entry.id);
    },
  };
}
