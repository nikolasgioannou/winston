import { describe, expect, test } from "bun:test";
import type {
  BrowserActionResponse,
  BrowserSnapshotResponse,
  BrowserWindowInfo,
} from "@winston/domain/browser";
import {
  autopilotLimits,
  candidatesIn,
  commitsSomething,
  createAutopilot,
} from "./autopilot.ts";

const token = (runId: string) =>
  `${Buffer.from(
    JSON.stringify({ runId, kind: "background", exp: Date.now() + 60_000 }),
  ).toString("base64url")}.sig`;

const windowAt = (url: string): BrowserWindowInfo =>
  ({ id: "win_1", owner: "task_1", url, title: "Page" }) as BrowserWindowInfo;

const page = [
  'navigation "Main"',
  '  link "Home" [e1]',
  '  searchbox "Search" [e2]',
  "main",
  '  link "Bun docs" [e3]',
  '  button "Place order" [e4]',
  '  text "Hello"',
];

interface JevTurn {
  pick: string;
  p?: number;
  done?: number;
  stuck?: number;
}

/** A fake browser and backend: Jev answers from a script of turns. */
function harness({
  turns,
  reliable = true,
  jevStatus = 200,
}: {
  turns: JevTurn[];
  reliable?: boolean;
  jevStatus?: number;
}) {
  const clicks: string[] = [];
  const outcomes: { decisions: unknown; outcome: string }[] = [];
  const asked: unknown[] = [];
  let turn = 0;
  const autopilot = createAutopilot({
    snapshot: () =>
      Promise.resolve({
        window: windowAt("https://shop.example.com/search"),
        lines: page,
        more: 0,
        readOnly: false,
      } satisfies BrowserSnapshotResponse),
    click: (_token, ref) => {
      clicks.push(ref);
      return Promise.resolve({
        did: `Clicked ${ref}.`,
        window: windowAt("https://shop.example.com/next"),
        navigated: true,
        settled: true,
        opened: [],
      } as unknown as BrowserActionResponse);
    },
    backend: (request) => {
      if (request.path.startsWith("/v1/jev/sites/"))
        return Promise.resolve({
          status: 200,
          body: JSON.stringify({ reliable }),
        });
      if (request.path === "/v1/jev/outcome") {
        outcomes.push(JSON.parse(request.body ?? "{}") as never);
        return Promise.resolve({ status: 200, body: "{}" });
      }
      asked.push(JSON.parse(request.body ?? "{}"));
      if (jevStatus !== 200)
        return Promise.resolve({ status: jevStatus, body: "{}" });
      const t = turns[Math.min(turn, turns.length - 1)] ?? { pick: "e1" };
      turn += 1;
      return Promise.resolve({
        status: 200,
        body: JSON.stringify({
          decisionId: `jev_${String(turn)}`,
          answers: {
            action: {
              type: "choice",
              choice: t.pick,
              probabilities: { [t.pick]: t.p ?? 0.9 },
            },
            goal_done: { type: "noul", noul: t.done ?? 0.1 },
            stuck: { type: "noul", noul: t.stuck ?? 0.1 },
          },
        }),
      });
    },
  });
  return { autopilot, clicks, outcomes, asked };
}

describe("autopilot", () => {
  test("clicks while Jev is confident, then stops when the sub-goal looks met", async () => {
    const h = harness({
      turns: [{ pick: "e3" }, { pick: "e1" }, { pick: "e1", done: 0.95 }],
    });
    const result = await h.autopilot.run(token("task_1"), {
      goal: "open the docs",
    });
    expect(h.clicks).toEqual(["e3", "e1"]);
    expect(result).toMatchObject({
      stop: "goal_met",
      actions: ["Clicked e3.", "Clicked e1."],
    });
    // Jev was asked about the refs as the snapshot labels them.
    const first = h.asked[0] as {
      domain: string;
      questions: { action: { criteria: Record<string, string> } };
    };
    expect(first.domain).toBe("example.com");
    expect(first.questions.action.criteria).toEqual({
      e1: 'link "Home"',
      e2: 'searchbox "Search"',
      e3: 'link "Bun docs"',
      e4: 'button "Place order"',
    });
  });

  test("hands back when unsure, at typing, before committing, when stuck, and at the step limit", async () => {
    const stopOf = async (turns: JevTurn[], maxSteps?: number) => {
      const h = harness({ turns });
      const result = await h.autopilot.run(token("task_1"), {
        goal: "find it",
        ...(maxSteps ? { maxSteps } : {}),
      });
      return { stop: result.stop, clicks: h.clicks, reason: result.reason };
    };
    expect(await stopOf([{ pick: "e3", p: 0.3 }])).toMatchObject({
      stop: "unsure",
      clicks: [],
    });
    expect(await stopOf([{ pick: "e2" }])).toMatchObject({
      stop: "needs_typing",
      reason: 'The next step needs typing into e2 (searchbox "Search").',
    });
    expect(await stopOf([{ pick: "e4" }])).toMatchObject({
      stop: "commits",
      clicks: [],
    });
    // Stuck counts only from the third step.
    expect(await stopOf([{ pick: "e1", stuck: 0.9 }])).toMatchObject({
      stop: "stuck",
      clicks: ["e1", "e1"],
    });
    expect(await stopOf([{ pick: "e1" }], 3)).toMatchObject({
      stop: "max_steps",
      clicks: ["e1", "e1", "e1"],
    });
  });

  test("a site where Jev keeps being overridden gets no autopilot; Jev being down says so", async () => {
    const off = harness({ turns: [{ pick: "e1" }], reliable: false });
    expect(
      await off.autopilot.run(token("task_1"), { goal: "x" }),
    ).toMatchObject({ stop: "unreliable", actions: [] });
    expect(off.asked).toEqual([]);

    const down = harness({ turns: [], jevStatus: 503 });
    expect(
      await down.autopilot.run(token("task_1"), { goal: "x" }),
    ).toMatchObject({ stop: "unavailable" });
  });

  test("the agent's next move judges the picks: going back overrides them, anything else keeps them", async () => {
    const h = harness({ turns: [{ pick: "e3" }, { pick: "e3", p: 0.2 }] });
    await h.autopilot.run(token("task_1"), { goal: "open the docs" });
    expect(h.outcomes).toEqual([]);
    h.autopilot.observe(token("task_1"), "navigate", { back: true });
    expect(h.outcomes).toEqual([
      {
        decisions: [
          { id: "jev_1", action: 'click e3 (link "Bun docs")' },
          { id: "jev_2", action: null },
        ],
        outcome: "overridden",
      },
    ]);
    // Once judged, later moves change nothing; another run's moves never do.
    h.autopilot.observe(token("task_1"), "click", {});
    await h.autopilot.run(token("task_1"), { goal: "again" });
    h.autopilot.observe(token("task_2"), "click", {});
    h.autopilot.observe(token("task_1"), "click", {});
    expect(h.outcomes.map((o) => o.outcome)).toEqual([
      "overridden",
      "verified",
    ]);
  });

  test("commit heuristics are conservative, but moving toward checkout isn't committing", () => {
    for (const name of [
      "Place order",
      "Buy now",
      "Pay $42.10",
      "Send",
      "Confirm booking",
      "Delete account",
      "I agree",
      "Submit",
    ])
      expect(commitsSomething("button", name)).toBe(true);
    for (const name of [
      "Checkout",
      "Proceed to checkout",
      "Next page",
      "Bun docs",
    ])
      expect(commitsSomething("button", name)).toBe(false);
    expect(commitsSomething("checkbox", "Send me offers")).toBe(false);
    expect(candidatesIn(page).map((c) => c.ref)).toEqual([
      "e1",
      "e2",
      "e3",
      "e4",
    ]);
    const many = Array.from(
      { length: 300 },
      (_, i) => `link "L" [e${String(i)}]`,
    );
    expect(candidatesIn(many)).toHaveLength(autopilotLimits.maxOptions);
  });
});
