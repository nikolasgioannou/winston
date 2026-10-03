import { describe, expect, test } from "bun:test";
import { cli } from "../testing.ts";
import { timeoutMs } from "./browser.ts";

const win = (overrides: Record<string, unknown> = {}) => ({
  id: "win_01k5x9q8f3e2d1c0b9a8z7y6x5",
  owner: "run_1",
  url: "https://example.com/",
  title: "Example",
  openedBy: null,
  current: true,
  mine: true,
  locks: [],
  ...overrides,
});

const action = (overrides: Record<string, unknown> = {}) => ({
  did: 'Clicked e5 (button "Sign in").',
  window: win(),
  navigated: false,
  settled: true,
  opened: [],
  dialog: null,
  handledDialogs: [],
  ...overrides,
});

const bodyOf = async (request: Request | undefined) =>
  (await request?.json()) as Record<string, unknown>;

describe("winston browser", () => {
  test("click sends the ref to winstond and says what changed", async () => {
    const { out, requests } = await cli(["browser", "click", "e5"], () =>
      Response.json(
        action({
          navigated: true,
          window: win({ url: "https://example.com/home", title: "Home" }),
          dialog: { type: "confirm", message: "Leave?", defaultPrompt: "" },
          settled: false,
        }),
      ),
    );
    expect(new URL(requests[0]?.url ?? "").pathname).toBe("/v1/browser/click");
    expect(await bodyOf(requests[0])).toEqual({ ref: "e5" });
    expect(out).toBe(
      [
        'Clicked e5 (button "Sign in").',
        'Now at https://example.com/home ("Home"). Refs from your last snapshot are gone; snapshot again.',
        'The page is asking (confirm): "Leave?". Answer with winston browser dialog accept or dismiss.',
        "The page was still changing when the wait ended; snapshot before your next step.",
      ].join("\n"),
    );
  });

  test("a missing or malformed ref is a usage error, without calling winstond", async () => {
    for (const argv of [
      ["browser", "click"],
      ["browser", "click", "#submit"],
      ["browser", "type", "e2"],
    ]) {
      const { code, requests } = await cli(argv, () => Response.json({}));
      expect(code).toBe(1);
      expect(requests).toHaveLength(0);
    }
  });

  test("type sends the text and its switches; wait tells a ref from text", async () => {
    const typed = await cli(
      ["browser", "type", "e2", "tacos near me", "--clear", "--submit"],
      () => Response.json(action({ did: "Typed into e2." })),
    );
    expect(await bodyOf(typed.requests[0])).toEqual({
      ref: "e2",
      text: "tacos near me",
      clear: true,
      submit: true,
    });
    const forRef = await cli(["browser", "wait", "--for", "e12"], () =>
      Response.json(action({ did: "e12 is visible." })),
    );
    expect(await bodyOf(forRef.requests[0])).toEqual({
      ref: "e12",
      timeoutMs: 10_000,
    });
    const forText = await cli(
      ["browser", "wait", "--for", "Order confirmed", "--timeout", "30s"],
      () => Response.json(action({ did: "Found." })),
    );
    expect(await bodyOf(forText.requests[0])).toEqual({
      text: "Order confirmed",
      timeoutMs: 30_000,
    });
  });

  test("snapshot prints the page under its window; a peek says it's read-only", async () => {
    const own = await cli(["browser", "snapshot"], () =>
      Response.json({
        window: win(),
        lines: ['button "Sign in" [e1]'],
        more: 4,
        readOnly: false,
      }),
    );
    expect(own.out).toBe(
      [
        "win_01k5x9q8f3e2d1c0b9a8z7y6x5 · Example",
        "  https://example.com/",
        'button "Sign in" [e1]',
        "… 4 more lines (a long page). Act on what's here, or scroll and snapshot again.",
      ].join("\n"),
    );
    const peek = await cli(
      ["browser", "snapshot", "--window", "win_01k5x9q8f3e2d1c0b9a8z7y6x5"],
      () =>
        Response.json({
          window: win({ mine: false, owner: "run_2" }),
          lines: ['button "Sign in"'],
          more: 0,
          readOnly: true,
        }),
    );
    expect(peek.out.split("\n")[0]).toBe(
      "Read-only peek at win_01k5x9q8f3e2d1c0b9a8z7y6x5 (task run_2): no refs, since you can't act in it.",
    );
  });

  test("list is windows by another name, as the verb every other noun uses", async () => {
    const { out, requests } = await cli(["browser", "list"], () =>
      Response.json({ windows: [win()] }),
    );
    expect(new URL(requests[0]?.url ?? "").pathname).toBe(
      "/v1/browser/windows",
    );
    expect(out).toContain("win_01k5x9q8f3e2d1c0b9a8z7y6x5");
  });

  test("autopilot sends the goal and its limits, and prints what it did, why it stopped and how long it took", async () => {
    const { out, requests } = await cli(
      [
        "browser",
        "autopilot",
        "buy",
        "the",
        "blue",
        "mug",
        "--max-steps",
        "5",
        "--max-seconds",
        "20",
      ],
      () =>
        Response.json({
          actions: [
            'Typed "blue mug" into [1] Search.',
            "Clicked [3] Blue mug.",
          ],
          stop: "commits",
          reason:
            "The next step would commit something: [9] Place order. Decide it yourself.",
          window: win({ url: "https://example.com/p", title: "Mug" }),
          elapsedMs: 2_340,
        }),
    );
    expect(await bodyOf(requests[0])).toEqual({
      goal: "buy the blue mug",
      maxSteps: 5,
      maxSeconds: 20,
    });
    expect(out).toBe(
      [
        '- Typed "blue mug" into [1] Search.',
        "- Clicked [3] Blue mug.",
        "Stopped (commits) after 2.3 s: The next step would commit something: [9] Place order. Decide it yourself.",
        'Now at https://example.com/p ("Mug"). Snapshot to check.',
      ].join("\n"),
    );
  });

  test("timeouts read as seconds, minutes or milliseconds, capped at 2 minutes", () => {
    expect(timeoutMs("10s")).toBe(10_000);
    expect(timeoutMs("2m")).toBe(120_000);
    expect(timeoutMs("10m")).toBe(120_000);
    expect(timeoutMs("500ms")).toBe(500);
    expect(() => timeoutMs("soon")).toThrow();
  });
});
