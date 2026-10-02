import { describe, expect, test } from "bun:test";
import type { Cdp, CdpEvent } from "./cdp.ts";
import {
  BrowserFailure,
  browserTimings,
  createBrowser,
  normalizeUrl,
  ownerOf,
} from "./windows.ts";

/** A run token as the backend mints it (the signature isn't checked here). */
const token = (runId: string, kind = "background", exp = Date.now() + 60_000) =>
  `${Buffer.from(JSON.stringify({ runId, userId: "usr_1", kind, exp })).toString("base64url")}.sig`;

/** Chrome standing in: targets, sessions, navigation and its events. */
function fakeChrome() {
  const listeners = new Set<(event: CdpEvent) => void>();
  let crash: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => (crash = resolve));
  const urls = new Map<string, string>();
  const history = new Map<string, string[]>();
  const sent: { method: string; params: Record<string, unknown> }[] = [];
  let targets = 0;
  let loads = 0;
  const emit = (event: CdpEvent) => {
    for (const listener of listeners) listener(event);
  };
  const targetOf = (sessionId: string | undefined) =>
    (sessionId ?? "").replace(/^s-/, "");
  const cdp: Cdp = {
    send<T>(
      method: string,
      params: Record<string, unknown> = {},
      sessionId?: string,
    ) {
      sent.push({ method, params });
      const answer = (value: unknown) => Promise.resolve(value as T);
      switch (method) {
        case "Target.createTarget": {
          targets += 1;
          const targetId = `t${String(targets)}`;
          urls.set(targetId, "about:blank");
          history.set(targetId, ["about:blank"]);
          return answer({ targetId });
        }
        case "Target.attachToTarget":
          return answer({ sessionId: `s-${String(params.targetId)}` });
        case "Page.navigate": {
          const url = String(params.url);
          if (url.includes("unreachable"))
            return answer({
              frameId: "f",
              errorText: "net::ERR_NAME_NOT_RESOLVED",
            });
          loads += 1;
          const loaderId = `l${String(loads)}`;
          const targetId = targetOf(sessionId);
          urls.set(targetId, url);
          history.get(targetId)?.push(url);
          if (!url.includes("slow"))
            setTimeout(() => {
              for (const name of ["load", "networkAlmostIdle"])
                emit({
                  method: "Page.lifecycleEvent",
                  params: { frameId: "f", loaderId, name },
                  ...(sessionId ? { sessionId } : {}),
                });
            }, 5);
          return answer({ frameId: "f", loaderId });
        }
        case "Target.getTargetInfo": {
          const targetId = String(params.targetId);
          const url = urls.get(targetId) ?? "about:blank";
          return answer({
            targetInfo: {
              targetId,
              type: "page",
              url,
              title: `Title of ${url}`,
            },
          });
        }
        case "Page.getFrameTree":
          return answer({ frameTree: { frame: { id: "f" } } });
        case "Accessibility.getFullAXTree":
          return answer({
            nodes: [
              { nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2"] },
              {
                nodeId: "2",
                role: { value: "button" },
                name: { value: "Go" },
                backendDOMNodeId: 7,
              },
            ],
          });
        case "Page.getNavigationHistory":
          // Every window here is on its first page.
          return answer({ currentIndex: 0, entries: [{ id: 0 }] });
        case "Target.closeTarget":
          emit({
            method: "Target.targetDestroyed",
            params: { targetId: params.targetId },
          });
          return answer({ success: true });
        default:
          return answer({});
      }
    },
    on(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    closed,
    close: () => {
      crash();
    },
  };
  return {
    cdp,
    emit,
    sent,
    crash: () => {
      crash();
    },
  };
}

function setup(now?: () => number) {
  let chrome = fakeChrome();
  const browser = createBrowser({
    connect: () => Promise.resolve(chrome.cdp),
    ...(now ? { now } : {}),
  });
  return {
    browser,
    chrome: () => chrome,
    /** Chrome crashes and systemd brings up a new one. */
    restartChrome: async () => {
      chrome.crash();
      await Bun.sleep(1);
      chrome = fakeChrome();
    },
  };
}

const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BrowserFailure) return error;
    throw error;
  }
  throw new Error("expected a BrowserFailure");
};

describe("run tokens and URLs", () => {
  test("the front of house owns windows across its turns; a background run by its id", () => {
    expect(ownerOf(token("run_a", "front")).owner).toBe("front");
    expect(ownerOf(token("run_b", "front")).owner).toBe("front");
    expect(ownerOf(token("run_c")).owner).toBe("run_c");
    expect(() => ownerOf("not-a-token")).toThrow(BrowserFailure);
  });

  test("a bare address means https", () => {
    expect(normalizeUrl("example.com/a")).toBe("https://example.com/a");
    expect(normalizeUrl("http://x.test")).toBe("http://x.test");
    expect(normalizeUrl("about:blank")).toBe("about:blank");
  });
});

describe("agent windows", () => {
  test("each run opens its own window in a new Chrome window, and commands act on it by default", async () => {
    const { browser, chrome } = setup();
    const a = await browser.open(token("run_a"), "example.com");
    expect(a.loaded).toBe(true);
    expect(a.window).toMatchObject({
      url: "https://example.com",
      title: "Title of https://example.com",
      mine: true,
      current: true,
    });
    expect(
      chrome().sent.find((s) => s.method === "Target.createTarget")?.params,
    ).toEqual({ url: "about:blank", newWindow: true });
    const b = await browser.open(token("run_b"), "b.test");
    const moved = await browser.navigate(token("run_a"), {
      url: "a.test/next",
    });
    expect(moved.window.id).toBe(a.window.id);
    const listed = await browser.windows(token("run_b"));
    expect(listed.map((w) => [w.id, w.mine, w.current])).toEqual([
      [a.window.id, false, false],
      [b.window.id, true, true],
    ]);
    // Nothing turned on Runtime, which pages can detect.
    expect(chrome().sent.some((s) => s.method === "Runtime.enable")).toBe(
      false,
    );
  });

  test("another run's window can be looked up but not driven; no window yet says how to open one", async () => {
    const { browser } = setup();
    const a = await browser.open(token("run_a"));
    expect((await browser.window(token("run_b"), a.window.id)).mine).toBe(
      false,
    );
    const refused = await failure(
      browser.navigate(token("run_b"), { url: "x.test" }, a.window.id),
    );
    expect(refused.code).toBe("invalid_request");
    expect((await failure(browser.close(token("run_b")))).message).toBe(
      "You don't have a browser window yet.",
    );
  });

  test("a page the window opens joins the same run and becomes its current window", async () => {
    const { browser, chrome } = setup();
    const a = await browser.open(token("run_a"), "a.test");
    // The page opens a popup while navigating (target=_blank, window.open).
    const navigating = browser.navigate(token("run_a"), { url: "a.test/2" });
    chrome().emit({
      method: "Target.targetCreated",
      params: {
        targetInfo: {
          targetId: "t9",
          type: "page",
          url: "https://pay.test",
          title: "",
          openerId: "t1",
        },
      },
    });
    const result = await navigating;
    expect(result.opened).toHaveLength(1);
    expect(result.opened[0]).toMatchObject({
      openedBy: a.window.id,
      current: true,
      mine: true,
    });
    const closed = await browser.close(token("run_a"));
    expect(closed.current).toBe(a.window.id);
  });

  test("navigation waits for load; a slow page reports it's still loading; a bad address fails", async () => {
    const { browser } = setup();
    await browser.open(token("run_a"));
    const saved = browserTimings.loadTimeoutMs;
    browserTimings.loadTimeoutMs = 50;
    try {
      const slow = await browser.navigate(token("run_a"), { url: "slow.test" });
      expect(slow.loaded).toBe(false);
    } finally {
      browserTimings.loadTimeoutMs = saved;
    }
    const bad = await failure(
      browser.navigate(token("run_a"), { url: "unreachable.test" }),
    );
    expect(bad.message).toBe(
      "Couldn't load unreachable.test: net::ERR_NAME_NOT_RESOLVED.",
    );
    const none = await failure(
      browser.navigate(token("run_a"), { back: true }),
    );
    expect(none.message).toBe("There's no page to go back to.");
  });

  test("a new document in the window gets fresh refs, never reusing a number", async () => {
    const { browser, chrome } = setup();
    await browser.open(token("run_a"), "a.test");
    // Chrome hands out the same node ids on the next site.
    const snapshotOf = async () => {
      const result = await browser.snapshot(token("run_a"), {});
      return result.lines.join("\n");
    };
    expect(await snapshotOf()).toBe('button "Go" [e1]');
    expect(await snapshotOf()).toBe('button "Go" [e1]');
    chrome().emit({
      method: "Page.frameNavigated",
      params: { frame: { id: "f" } },
      sessionId: "s-t1",
    });
    expect(await snapshotOf()).toBe('button "Go" [e2]');
    expect((await failure(browser.target(token("run_a"), "e1"))).code).toBe(
      "not_found",
    );
  });

  test("after Chrome restarts, a run's next command says its window was closed, once", async () => {
    const { browser, restartChrome } = setup();
    const a = await browser.open(token("run_a"), "a.test");
    await restartChrome();
    expect(
      (await failure(browser.navigate(token("run_a"), { url: "b.test" })))
        .message,
    ).toBe("Chrome restarted, so your window was closed.");
    expect(
      (await failure(browser.window(token("run_b"), a.window.id))).message,
    ).toBe("Chrome restarted, so your window was closed.");
    const fresh = await browser.open(token("run_a"), "a.test");
    expect(fresh.window.id).not.toBe(a.window.id);
  });

  test("windows of runs that ended are closed after 30 idle minutes; a live run's are kept", async () => {
    let clock = Date.now();
    const { browser } = setup(() => clock);
    const ended = await browser.open(
      token("run_a", "background", clock + 60_000),
    );
    const live = await browser.open(
      token("run_b", "background", clock + 2 * browserTimings.idleMs),
    );
    clock += browserTimings.idleMs + 120_000;
    expect(await browser.sweep()).toEqual([ended.window.id]);
    expect((await browser.windows(token("run_c"))).map((w) => w.id)).toEqual([
      live.window.id,
    ]);
  });
});
