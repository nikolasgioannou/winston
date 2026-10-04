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
  test("click-xy sends the point and says what changed", async () => {
    const { out, requests } = await cli(
      ["browser", "click-xy", "640", "360"],
      () =>
        Response.json(
          action({
            did: "Clicked at (640, 360).",
            navigated: true,
            window: win({ url: "https://example.com/home", title: "Home" }),
            dialog: { type: "confirm", message: "Leave?", defaultPrompt: "" },
            settled: false,
          }),
        ),
    );
    expect(new URL(requests[0]?.url ?? "").pathname).toBe(
      "/v1/browser/click-xy",
    );
    expect(await bodyOf(requests[0])).toEqual({ x: 640, y: 360 });
    expect(out).toBe(
      [
        "Clicked at (640, 360).",
        'Now at https://example.com/home ("Home").',
        'The page is asking (confirm): "Leave?". Answer with winston browser dialog accept or dismiss.',
        "The page was still changing when the wait ended; look before your next step.",
      ].join("\n"),
    );
  });

  test("acting goes through act: the per-element commands and autopilot are gone, without calling winstond", async () => {
    for (const argv of [
      ["browser", "click", "e5"],
      ["browser", "type", "e2", "tacos"],
      ["browser", "select", "e3", "Cyprus"],
      ["browser", "press", "Enter"],
      ["browser", "scroll"],
      ["browser", "autopilot", "search for tacos"],
      ["browser", "click-xy", "640"],
      ["browser", "act"],
    ]) {
      const { code, requests } = await cli(argv, () => Response.json({}));
      expect([argv.join(" "), code]).toEqual([argv.join(" "), 1]);
      expect(requests).toHaveLength(0);
    }
  });

  test("wait sends the text to wait for", async () => {
    const forText = await cli(
      ["browser", "wait", "--for", "Order confirmed", "--timeout", "30s"],
      () => Response.json(action({ did: "Found." })),
    );
    expect(await bodyOf(forText.requests[0])).toEqual({
      text: "Order confirmed",
      timeoutMs: 30_000,
    });
  });

  test("snapshot prints the page under its window, for reading; a peek says it's read-only", async () => {
    const own = await cli(["browser", "snapshot"], () =>
      Response.json({
        window: win(),
        lines: ['button "Sign in"'],
        more: 4,
        readOnly: false,
      }),
    );
    expect(own.out).toBe(
      [
        "win_01k5x9q8f3e2d1c0b9a8z7y6x5 · Example",
        "  https://example.com/",
        'button "Sign in"',
        "… 4 more lines (a long page).",
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
      "Read-only peek at win_01k5x9q8f3e2d1c0b9a8z7y6x5 (task run_2).",
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

  test("act sends the instruction, its limits and --commit, and prints what it did, why it stopped and the page it ended on", async () => {
    const { out, requests } = await cli(
      [
        "browser",
        "act",
        "buy",
        "the",
        "blue",
        "mug",
        "--max-steps",
        "5",
        "--max-seconds",
        "20",
        "--commit",
      ],
      () =>
        Response.json({
          actions: [
            'Typed "blue mug" into [1] Search.',
            "Clicked [3] Blue mug.",
            "Clicked [9] Place order.",
          ],
          stop: "committed",
          reason:
            "It took the step that commits. Check the page below to confirm it went through.",
          window: win({ url: "https://example.com/done", title: "Thanks" }),
          elapsedMs: 2_340,
          escalated: 1,
          page: {
            title: "Thanks",
            url: "https://example.com/done",
            text: "Order #1234 placed",
          },
        }),
    );
    // The route keeps autopilot's name, which daemons not yet updated know.
    expect(new URL(requests[0]?.url ?? "").pathname).toBe(
      "/v1/browser/autopilot",
    );
    expect(await bodyOf(requests[0])).toEqual({
      goal: "buy the blue mug",
      maxSteps: 5,
      maxSeconds: 20,
      commit: true,
    });
    expect(out).toBe(
      [
        '- Typed "blue mug" into [1] Search.',
        "- Clicked [3] Blue mug.",
        "- Clicked [9] Place order.",
        "Stopped (committed) after 2.3 s (1 step decided by the stronger model): It took the step that commits. Check the page below to confirm it went through.",
        'Now at https://example.com/done ("Thanks"). On screen:',
        "Order #1234 placed",
      ].join("\n"),
    );

    // An older daemon answers without the page.
    const older = await cli(["browser", "act", "open the first result"], () =>
      Response.json({
        actions: [],
        stop: "done",
        reason: "Jev says the goal is met.",
        window: win(),
        elapsedMs: 900,
      }),
    );
    expect(older.out.split("\n").at(-1)).toBe(
      'Now at https://example.com/ ("Example"). Snapshot to check.',
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
