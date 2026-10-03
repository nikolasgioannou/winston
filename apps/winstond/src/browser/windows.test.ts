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
        case "Page.getLayoutMetrics":
          return answer({
            cssVisualViewport: { clientWidth: 1280, clientHeight: 800 },
            cssContentSize: { width: 1280, height: 20_000 },
          });
        case "Page.captureScreenshot":
          return answer({ data: Buffer.from("png-bytes").toString("base64") });
        case "Page.createIsolatedWorld":
          return answer({ executionContextId: 7 });
        case "Runtime.evaluate": {
          const code = String(params.expression);
          if (code.includes("boom"))
            return answer({
              result: { type: "object" },
              exceptionDetails: {
                text: "Uncaught",
                exception: {
                  description:
                    "ReferenceError: boom is not defined\n    at <anonymous>",
                },
              },
            });
          if (code.includes("long"))
            return answer({
              result: { type: "string", value: "x".repeat(5_000) },
            });
          if (code.includes("nothing"))
            return answer({ result: { type: "undefined" } });
          return answer({
            result: { type: "object", value: { title: "Example", n: 2 } },
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
  const saved: { path: string; bytes: string }[] = [];
  const browser = createBrowser({
    connect: () => Promise.resolve(chrome.cdp),
    saveFile: (path, bytes) => {
      saved.push({ path, bytes: Buffer.from(bytes).toString() });
      return Promise.resolve();
    },
    ...(now ? { now } : {}),
  });
  return {
    browser,
    saved,
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
    // A clock that moves on every read, as a slow machine's does between steps.
    let tick = Date.now();
    const { browser, chrome } = setup(() => tick++);
    const a = await browser.open(token("run_a"), "a.test");
    // The page opens a popup while navigating (target=_blank, window.open):
    // once the navigation is under way, so it's newer than the command.
    const navigating = browser.navigate(token("run_a"), { url: "a.test/2" });
    while (
      !chrome().sent.some(
        (m) =>
          m.method === "Page.navigate" && m.params.url === "https://a.test/2",
      )
    )
      await Bun.sleep(1);
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
    // The old ref is gone, so an action with it is refused, not misdirected.
    const refused = await failure(browser.click(token("run_a"), "e1"));
    expect(refused.message).toStartWith("There's no e1 in your last snapshot");
    expect(refused.code).toBe("invalid_request");
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

  test("a screenshot of a background window is saved under the caller's run and its path printed; a full page is capped", async () => {
    const { browser, saved, chrome } = setup();
    const theirs = await browser.open(token("run_a"), "a.test");
    await browser.open(token("run_b"), "b.test");
    // run_b peeks at run_a's window, which isn't in front.
    const shot = await browser.screenshot(token("run_b"), {
      window: theirs.window.id,
    });
    expect(shot.path).toMatch(
      new RegExp(
        `^/home/winston/\\.winston/screenshots/run_b/.+-${theirs.window.id}\\.png$`,
      ),
    );
    expect(saved[0]).toEqual({
      path: shot.path.replace("/home/winston/", ""),
      bytes: "png-bytes",
    });
    expect([shot.width, shot.height, shot.fullPage, shot.clipped]).toEqual([
      1280,
      800,
      false,
      false,
    ]);
    const full = await browser.screenshot(token("run_b"), { fullPage: true });
    expect([full.height, full.clipped]).toEqual([12_000, true]);
    expect(
      chrome()
        .sent.filter((s) => s.method === "Page.captureScreenshot")
        .at(-1)?.params,
    ).toEqual({
      format: "png",
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: 1280, height: 12_000, scale: 1 },
    });
  });

  test("eval prints the result as JSON, cut short when long, and says clearly when the script threw", async () => {
    const { browser, chrome } = setup();
    await browser.open(token("run_a"), "a.test");
    const value = await browser.eval(token("run_a"), {
      code: "document.title",
    });
    expect(value.value).toBe('{\n  "title": "Example",\n  "n": 2\n}');
    // An expression is returned; it runs in the isolated world.
    expect(
      chrome().sent.find((s) => s.method === "Runtime.evaluate")?.params,
    ).toMatchObject({
      expression: "(async () => {\nreturn (document.title\n);\n})()",
      contextId: 7,
    });
    const long = await browser.eval(token("run_a"), { code: "long" });
    // 5,000 characters, plus the JSON string's two quotes.
    expect([Array.from(long.value).length, long.more]).toEqual([4_000, 1_002]);
    expect(
      (await browser.eval(token("run_a"), { code: "nothing" })).value,
    ).toBe("undefined");
    const thrown = await failure(
      browser.eval(token("run_a"), { code: "boom()" }),
    );
    expect(thrown.message).toBe(
      "The script threw: ReferenceError: boom is not defined",
    );
    expect(thrown.hint).toContain("--page-world");
  });

  test("a run acting on a site holds it: another run's navigation there is refused, its peeks aren't, and closing frees it", async () => {
    const { browser } = setup();
    const a = await browser.open(token("run_a"), "https://www.shop.test/cart");
    expect(a.window.locks).toEqual(["shop.test"]);
    await browser.open(token("run_b"), "https://news.test");
    const refused = await failure(
      browser.navigate(token("run_b"), { url: "https://checkout.shop.test" }),
    );
    expect(refused.code).toBe("conflict");
    // Looking needs no lock.
    expect(
      (await browser.snapshot(token("run_b"), { window: a.window.id }))
        .readOnly,
    ).toBe(true);
    await browser.screenshot(token("run_b"), { window: a.window.id });
    await browser.close(token("run_a"));
    const moved = await browser.navigate(token("run_b"), {
      url: "https://checkout.shop.test",
    });
    expect(moved.window.locks).toEqual(["news.test", "shop.test"]);
  });

  test("a window held for the user can't be acted in, keeps its site, and is the run's again once released", async () => {
    let clock = Date.now();
    const { browser } = setup(() => clock);
    const a = await browser.open(
      token("run_a", "background", clock + 60 * 60_000),
      "https://shop.test",
    );
    expect(browser.hold("run_a")).toEqual({
      windowId: a.window.id,
      targetId: "t1",
      url: "https://shop.test",
    });
    expect(browser.hold("run_z")).toBeNull();
    const refused = await failure(
      browser.navigate(token("run_a"), { url: "https://shop.test/2" }),
    );
    expect(refused.message).toBe(
      `You handed ${a.window.id} to the user; it's theirs until they're done.`,
    );
    // Long past the lock's 5 minutes, the site is still the run's.
    clock += 60 * 60_000;
    await browser.open(token("run_b"), "https://news.test");
    expect(
      (
        await failure(
          browser.navigate(token("run_b"), { url: "https://shop.test" }),
        )
      ).code,
    ).toBe("conflict");
    // Nor is a held window swept as idle.
    expect(await browser.sweep()).toEqual([]);
    browser.release("run_a");
    await browser.navigate(token("run_a"), { url: "https://shop.test/2" });
  });

  test("a run that ended has its windows closed and its sites freed at once, held ones too", async () => {
    const { browser, chrome } = setup();
    const a = await browser.open(token("run_a"), "https://shop.test");
    const second = await browser.open(token("run_a"), "https://news.test");
    browser.hold("run_a");
    const other = await browser.open(token("run_b"), "https://mail.test");
    expect((await browser.closeOwner("run_a")).sort()).toEqual(
      [a.window.id, second.window.id].sort(),
    );
    expect(
      chrome()
        .sent.filter((m) => m.method === "Target.closeTarget")
        .map((m) => m.params.targetId),
    ).toEqual(["t1", "t2"]);
    expect((await browser.windows(token("run_b"))).map((w) => w.id)).toEqual([
      other.window.id,
    ]);
    // Its sites are free for the next run straight away.
    await browser.navigate(token("run_b"), { url: "https://shop.test" });
  });

  test("a window given to another run keeps its page and site, becomes that run's current window, and the giver can only look", async () => {
    const { browser } = setup();
    const front = await browser.open(
      token("run_f", "front"),
      "https://air.test/checkin",
    );
    expect(browser.transfer("front", "task_1")).toEqual({
      windowId: front.window.id,
      targetId: "t1",
      url: "https://air.test/checkin",
    });
    // The task acts in it by default, holding its site.
    const moved = await browser.navigate(token("task_1"), {
      url: "https://air.test/checkin/passport",
    });
    expect(moved.window).toMatchObject({
      id: front.window.id,
      owner: "task_1",
      locks: ["air.test"],
    });
    const refused = await failure(
      browser.navigate(
        token("run_f", "front"),
        { url: "https://air.test/2" },
        front.window.id,
      ),
    );
    expect(refused.message).toBe(`${front.window.id} belongs to another task.`);
    expect(
      (
        await failure(
          browser.navigate(token("run_f", "front"), {
            url: "https://air.test",
          }),
        )
      ).code,
    ).toBe("not_found");
    // Nothing left to give, and a window held for the user isn't given away.
    expect(browser.transfer("front", "task_2")).toBeNull();
    await browser.open(token("run_g", "front"), "https://shop.test");
    browser.hold("front");
    expect(browser.transfer("front", "task_2")).toBeNull();
  });
});
