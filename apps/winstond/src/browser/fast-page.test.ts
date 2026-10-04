import { describe, expect, test } from "bun:test";
import type { Cdp } from "./cdp.ts";
import {
  DialogOpen,
  fastPage,
  fingerprint,
  readState,
  StalePage,
  type FastAction,
  type FastPage,
} from "./fast-page.ts";
import { BrowserFailure, type WindowEntry } from "./state.ts";

const observed = {
  url: "https://shop.test/",
  title: "Search",
  text: "Search",
  scroll: { y: 0, height: 800 },
  actions: [
    { id: "e1", kind: "click", label: "Go", role: "button", node: 1 },
    { id: "wait", kind: "wait", label: "Wait for the page to update" },
  ],
  marker: ["m"],
  page_key: ["k"],
  guards: { "1": ["g"] },
  omitted_actions: 0,
  frames: 0,
  viewport: { width: 1280, height: 800 },
};

/** Chrome standing in: answers the read, records every call. */
function fakeChrome(evaluate: (expression: string) => unknown) {
  const sent: { method: string; params: Record<string, unknown> }[] = [];
  const c = {
    send: (method: string, params: Record<string, unknown> = {}) => {
      sent.push({ method, params });
      if (method === "Page.getFrameTree")
        return Promise.resolve({ frameTree: { frame: { id: "F" } } });
      if (method === "Page.createIsolatedWorld")
        return Promise.resolve({ executionContextId: 77 });
      if (method === "Runtime.evaluate") {
        const value = evaluate(String(params.expression));
        return value instanceof Error
          ? Promise.resolve({ exceptionDetails: { text: value.message } })
          : Promise.resolve({ result: { value } });
      }
      return Promise.resolve({});
    },
  } as unknown as Cdp;
  const entry = { id: "win_1", worlds: new Map() } as unknown as WindowEntry;
  const pages = fastPage({
    sessionFor: () => Promise.resolve({ c, sessionId: "s1" }),
    sleep: () => Promise.resolve(),
  });
  return { pages, entry, sent };
}

const asPage = (state: typeof observed): FastPage => ({
  ...(state as unknown as FastPage),
  fingerprint: fingerprint(state as unknown as FastPage),
});

describe("autopilot's page reader", () => {
  test("an observation is one atomic read, in our isolated world", async () => {
    const { pages, entry, sent } = fakeChrome(() => observed);
    const page = await pages.observe(entry);
    expect(page.actions).toEqual(observed.actions as FastAction[]);
    const reads = sent.filter((m) => m.method === "Runtime.evaluate");
    expect(reads).toHaveLength(1);
    // Never the page's own world, where its scripts could see ours.
    expect(reads[0]?.params.contextId).toBe(77);
    expect(reads[0]?.params.expression).toBe(readState());
    expect(page.fingerprint).toBe(fingerprint(page));
  });

  test("a stale page gets no input at all", async () => {
    const { pages, entry, sent } = fakeChrome((expression) =>
      expression.includes("pageKey()") ? [["changed"], ["g"]] : observed,
    );
    const page = asPage(observed);
    const go = observed.actions[0] as FastAction;
    const error = await pages.act(entry, page, go).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StalePage);
    expect(sent.some((m) => m.method.startsWith("Input."))).toBe(false);
  });

  test("a fresh, unobstructed target is clicked where it is now", async () => {
    const { pages, entry, sent } = fakeChrome((expression) =>
      expression.includes("pageKey()")
        ? [["k"], ["g"]]
        : expression.includes("elementFromPoint")
          ? { x: 12, y: 34 }
          : observed,
    );
    await pages.act(entry, asPage(observed), observed.actions[0] as FastAction);
    const input = sent.filter((m) => m.method === "Input.dispatchMouseEvent");
    expect(input.map((m) => [m.params.type, m.params.x, m.params.y])).toEqual([
      ["mouseMoved", 12, 34],
      ["mousePressed", 12, 34],
      ["mouseReleased", 12, 34],
    ]);
  });

  test("a retried step is checked loosely: its element as it was, whatever the text around it or the address does", async () => {
    const decided: FastPage = {
      ...asPage(observed),
      page_key: ["doc-1", "https://maps.test/@1"],
      guards: { "1": [1, "button", "Go", null, "Live times 5:41 PM"] },
    };
    const go = observed.actions[0] as FastAction;
    const now = (
      guard: unknown[],
      pageKey = ["doc-1", "https://maps.test/@2"],
    ) =>
      fakeChrome((expression) =>
        expression.includes("pageKey()") ? [pageKey, guard] : observed,
      );
    const moved = now([1, "button", "Go", null, "Live times 5:42 PM"]);
    expect(await moved.pages.fresh(moved.entry, decided, go)).toBe(false);
    expect(
      await moved.pages.fresh(moved.entry, decided, go, { loose: true }),
    ).toBe(true);
    const renamed = now([1, "button", "Delete", null, "Live times 5:42 PM"]);
    expect(
      await renamed.pages.fresh(renamed.entry, decided, go, { loose: true }),
    ).toBe(false);
    const reloaded = now(
      [1, "button", "Go", null, "Live times 5:42 PM"],
      ["doc-2", "https://maps.test/@2"],
    );
    expect(
      await reloaded.pages.fresh(reloaded.entry, decided, go, { loose: true }),
    ).toBe(false);
  });

  test("an interrupted dropdown change is never retried as if nothing happened", async () => {
    const select: FastAction = {
      id: "e1",
      kind: "select",
      label: "Category → Design",
      value: "Design",
      node: 1,
    };
    for (const answer of [new Error("Execution context was destroyed"), null]) {
      const { pages, entry } = fakeChrome((expression) =>
        expression.includes("pageKey()") ? [["k"], ["g"]] : answer,
      );
      const error = await pages
        .act(entry, asPage(observed), select)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BrowserFailure);
      expect(error).not.toBeInstanceOf(StalePage);
    }
  });

  test("a dialog that opens mid-call ends the wait instead of hanging", async () => {
    const entry = { id: "win_1", worlds: new Map() } as unknown as WindowEntry;
    const c = {
      send: (method: string) => {
        if (method === "Page.getFrameTree")
          return Promise.resolve({ frameTree: { frame: { id: "F" } } });
        if (method === "Page.createIsolatedWorld")
          return Promise.resolve({ executionContextId: 7 });
        // Chrome holds the reply while a confirm is open.
        entry.dialog = { type: "confirm", message: "Sure?", defaultPrompt: "" };
        return new Promise(() => undefined);
      },
    } as unknown as Cdp;
    const pages = fastPage({
      sessionFor: () => Promise.resolve({ c, sessionId: "s1" }),
    });
    const error = await pages.observe(entry).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DialogOpen);
  });
});
