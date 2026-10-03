import { describe, expect, test } from "bun:test";
import type { BrowserWindowInfo } from "@winston/domain/browser";
import type { Cdp } from "./cdp.ts";
import {
  actionSpace,
  autopilotLimits,
  createAutopilot,
  InvalidAnswer,
  nextActionRules,
  validChoice,
} from "./autopilot.ts";
import {
  fingerprint,
  StalePage,
  type FastAction,
  type FastPage,
  type FastPageReader,
} from "./fast-page.ts";
import type { WindowEntry } from "./state.ts";

const token = `${Buffer.from(
  JSON.stringify({
    runId: "task_1",
    kind: "background",
    exp: Date.now() + 60_000,
  }),
).toString("base64url")}.sig`;

/** A search page: a field (typed into, or opened), and a Go button. */
function page(overrides: Partial<FastPage> = {}): FastPage {
  const actions: FastAction[] = overrides.actions ?? [
    {
      id: "e1",
      kind: "fill",
      label: "Search",
      role: "textbox",
      value: "",
      node: 10,
    },
    {
      id: "e2",
      kind: "click",
      label: "Open Search",
      role: "textbox",
      value: "",
      node: 10,
    },
    {
      id: "e3",
      kind: "click",
      label: "Go",
      role: "button",
      value: "",
      node: 20,
    },
    { id: "wait", kind: "wait", label: "Wait for the page to update" },
  ];
  const state = {
    url: "https://shop.test/",
    title: "Search",
    text: "Search",
    scroll: { y: 0, height: 800 },
    actions,
    marker: null,
    page_key: null,
    guards: {},
    omitted_actions: 0,
    frames: 0,
    framed: [],
    viewport: { width: 1280, height: 800 },
    ...overrides,
  };
  return { ...state, fingerprint: fingerprint(state) };
}

const choice = (ids: string[], selected: string) => ({
  type: "choice",
  choice: selected,
  confidence: 1,
  probabilities: Object.fromEntries(
    ids.map((id) => [id, id === selected ? 1 : 0]),
  ),
});

type Questions = Record<
  string,
  { criteria: Record<string, unknown>; instructions?: unknown }
>;
type Answer = (questions: Questions) => Record<string, unknown>;

/** Jev answering an operation (and the target for it, and nothing committing). */
const pick =
  (operation: string, target?: string, commits = "none"): Answer =>
  (questions) => ({
    operation: choice(
      Object.keys(questions.operation?.criteria ?? {}),
      operation,
    ),
    ...(target
      ? {
          [`${operation.toLowerCase()}_target`]: choice(
            Object.keys(
              questions[`${operation.toLowerCase()}_target`]?.criteria ?? {},
            ),
            target,
          ),
        }
      : {}),
    ...(questions.commits
      ? { commits: choice(Object.keys(questions.commits.criteria), commits) }
      : {}),
  });

/** Autopilot over a scripted page reader and backend. */
function harness({
  pages = [page()],
  answers,
  texts = ["dune"],
  fresh = () => true,
  act = () => Promise.resolve(),
  observe,
  reliable = true,
}: {
  pages?: FastPage[];
  answers: Answer[];
  texts?: (string | null)[];
  fresh?: () => boolean;
  act?: (action: FastAction, text?: string) => Promise<void>;
  observe?: (index: number) => Promise<FastPage>;
  reliable?: boolean;
}) {
  const acted: { id: string; text?: string }[] = [];
  const asked: Questions[] = [];
  const written: unknown[] = [];
  const outcomes: unknown[] = [];
  let reads = 0;
  const entry = {
    id: "win_1",
    url: "https://shop.test/",
    worlds: new Map(),
  } as unknown as WindowEntry;
  const pages_: FastPageReader = {
    observe: () => {
      const index = reads++;
      return observe
        ? observe(index)
        : Promise.resolve(pages[Math.min(index, pages.length - 1)] ?? page());
    },
    fresh: () => Promise.resolve(fresh()),
    act: async (_entry, _page, action, text) => {
      await act(action, text);
      acted.push({ id: action.id, ...(text !== undefined ? { text } : {}) });
    },
    settle: () => Promise.resolve(),
  };
  const autopilot = createAutopilot({
    pages: pages_,
    core: {
      caller: () => "task_1",
      windowFor: () => entry,
      sessionFor: () =>
        Promise.resolve({
          c: { send: () => Promise.resolve({}) } as unknown as Cdp,
          sessionId: "s1",
        }),
      refresh: () => Promise.resolve(),
      info: () =>
        ({ id: "win_1", url: entry.url, title: "Search" }) as BrowserWindowInfo,
      lock: () => undefined,
      now: Date.now,
    },
    backend: (request) => {
      const body = request.body
        ? (JSON.parse(request.body) as Record<string, unknown>)
        : {};
      if (request.path.startsWith("/v1/jev/sites/"))
        return Promise.resolve({
          status: 200,
          body: JSON.stringify({ reliable }),
        });
      if (request.path === "/v1/jev/outcome") {
        outcomes.push(body);
        return Promise.resolve({ status: 200, body: "{}" });
      }
      if (request.path === "/v1/jev/text") {
        written.push(body.context);
        return Promise.resolve({
          status: 200,
          body: JSON.stringify({ text: texts.shift() ?? null }),
        });
      }
      const questions = body.questions as Questions;
      asked.push(questions);
      const answer = answers.shift() ?? pick("DONE");
      return Promise.resolve({
        status: 200,
        body: JSON.stringify({
          decisionId: `jev_${String(asked.length)}`,
          answers: answer(questions),
        }),
      });
    },
  });
  return { autopilot, acted, asked, written, outcomes, reads: () => reads };
}

describe("autopilot's choices", () => {
  test("an invalid choice is rejected", () => {
    const valid = () => choice(["a", "b"], "a");
    const broken: Record<string, (a: ReturnType<typeof valid>) => void> = {
      unknown: (a) => {
        a.choice = "invented";
      },
      nan: (a) => {
        a.probabilities.a = Number.NaN;
      },
      missing: (a) => {
        delete a.probabilities.b;
      },
      negative: (a) => {
        a.probabilities.b = -1;
      },
      non_max: (a) => {
        a.choice = "b";
      },
      confidence: (a) => {
        a.confidence = 5;
      },
    };
    for (const breakIt of Object.values(broken)) {
      const answer = valid();
      breakIt(answer);
      expect(() => validChoice(answer, ["a", "b"])).toThrow(InvalidAnswer);
    }
    expect(validChoice(valid(), ["a", "b"]).choice).toBe("a");
  });

  test("one index per element, with targets per operation", () => {
    const { elements, targets, controls } = actionSpace(page().actions);
    expect(elements).toHaveLength(2);
    expect(elements[0]?.operations).toEqual(["TYPE_TEXT", "CLICK"]);
    expect(targets.TYPE_TEXT?.["1"]?.id).toBe("e1");
    expect(targets.CLICK?.["1"]?.id).toBe("e2");
    expect(targets.CLICK?.["2"]?.id).toBe("e3");
    expect(Object.keys(controls)).toEqual(["WAIT"]);
  });

  test("every question goes in one request, and only the head the operation picked acts", async () => {
    const { autopilot, asked, acted } = harness({
      answers: [
        (questions) => ({
          ...pick("TYPE_TEXT", "1")(questions),
          // An unused head can't act, even when it's nonsense.
          click_target: { choice: "invented" },
        }),
      ],
    });
    const result = await autopilot.run(token, { goal: "Search for dune" });
    expect(Object.keys(asked[0] ?? {}).sort()).toEqual([
      "click_target",
      "commits",
      "operation",
      "type_text_target",
    ]);
    expect(acted[0]).toEqual({ id: "e1", text: "dune" });
    expect(result.actions[0]).toBe('Typed "dune" into [1] Search.');
  });

  test("a click can't take a target from another head", async () => {
    const { autopilot, acted } = harness({
      answers: [
        (questions) => ({
          ...pick("CLICK")(questions),
          click_target: choice(["1", "2", "999"], "999"),
          type_text_target: choice(["1"], "1"),
        }),
      ],
    });
    const result = await autopilot.run(token, { goal: "Search for dune" });
    expect(result.stop).toBe("failed");
    expect(acted).toEqual([]);
  });

  test("target questions carry each control's state and the full rules", async () => {
    const checkbox: FastAction = {
      id: "toggle",
      kind: "click",
      label: "Free cancellation",
      role: "checkbox",
      checked: "true",
      node: 30,
    };
    const { autopilot, asked, acted } = harness({
      pages: [page({ actions: [checkbox, ...page().actions] })],
      answers: [pick("CLICK", "3")],
    });
    await autopilot.run(token, { goal: "Search with free cancellation" });
    const target = asked[0]?.click_target;
    expect((target?.criteria["1"] as { checked: string }).checked).toBe("true");
    expect(JSON.stringify(target?.instructions)).toContain(
      JSON.stringify(nextActionRules).slice(1, 40),
    );
    expect(acted[0]?.id).toBe("e3");
  });
});

describe("autopilot's loop", () => {
  test("a value the goal doesn't give stops the run before anything is typed", async () => {
    const { autopilot, acted, written } = harness({
      answers: [pick("TYPE_TEXT", "1")],
      texts: [null],
    });
    const result = await autopilot.run(token, { goal: "Check in" });
    expect(result.stop).toBe("needs_value");
    expect(result.reason).toContain("[1] Search");
    expect(written).toHaveLength(1);
    expect(acted).toEqual([]);
  });

  test("a stale decision is dropped before any input, and the page is read again", async () => {
    let freshness = false;
    const { autopilot, acted, written, reads } = harness({
      answers: [pick("TYPE_TEXT", "1"), pick("DONE")],
      fresh: () => {
        const was = freshness;
        freshness = true;
        return was;
      },
    });
    const result = await autopilot.run(token, { goal: "Search for dune" });
    expect(acted).toEqual([]);
    expect(written).toEqual([]);
    expect(reads()).toBe(2);
    expect(result.stop).toBe("done");
  });

  test("text written for a field is reused only when its context is the same", async () => {
    let failures = 1;
    const run = async (changed: boolean) => {
      const pages = [
        page(),
        page({ text: changed ? "Different page" : "Search" }),
      ];
      const h = harness({
        pages,
        answers: [pick("TYPE_TEXT", "1"), pick("TYPE_TEXT", "1"), pick("DONE")],
        texts: ["dune", "dune"],
        act: () => {
          if (failures-- > 0)
            return Promise.reject(new StalePage("changed before input"));
          return Promise.resolve();
        },
      });
      await h.autopilot.run(token, { goal: "Search for dune" });
      return h.written.length;
    };
    expect(await run(false)).toBe(1);
    failures = 1;
    expect(await run(true)).toBe(2);
  });

  test("waiting for a page to load isn't a lack of progress", async () => {
    const { autopilot, acted } = harness({
      answers: [...Array.from({ length: 5 }, () => pick("WAIT")), pick("DONE")],
    });
    const result = await autopilot.run(token, { goal: "Wait for results" });
    expect(acted.map((a) => a.id)).toEqual([
      "wait",
      "wait",
      "wait",
      "wait",
      "wait",
    ]);
    expect(result.stop).toBe("done");
  });

  test("three actions in a row that change nothing stop the run", async () => {
    const { autopilot, acted } = harness({
      answers: Array.from({ length: 5 }, () => pick("CLICK", "2")),
    });
    const result = await autopilot.run(token, { goal: "Search" });
    expect(acted).toHaveLength(3);
    expect(result.stop).toBe("no_progress");
  });

  test("an action is recorded even when the page won't settle afterwards", async () => {
    const { autopilot, acted } = harness({
      answers: [pick("CLICK", "2")],
      observe: (index) =>
        index === 0
          ? Promise.resolve(page())
          : Promise.reject(new StalePage("changed")),
    });
    const result = await autopilot.run(token, { goal: "Search" });
    expect(acted).toEqual([{ id: "e3" }]);
    expect(result.actions).toEqual(["Clicked [2] Go."]);
    expect(result.stop).toBe("failed");
  });

  test("a step that would commit something is left to the agent; anything else goes ahead", async () => {
    const order: FastAction = {
      id: "e1",
      kind: "click",
      label: "Place order",
      role: "button",
      node: 5,
    };
    const search: FastAction = {
      id: "e2",
      kind: "click",
      label: "Search",
      role: "button",
      node: 6,
    };
    const both = page({
      actions: [order, search, { id: "wait", kind: "wait", label: "Wait" }],
    });
    const stopped = harness({
      pages: [both],
      answers: [pick("CLICK", "1", "1")],
    });
    const result = await stopped.autopilot.run(token, { goal: "Buy it" });
    expect(result.stop).toBe("commits");
    expect(result.reason).toContain("[1] Place order");
    expect(stopped.acted).toEqual([]);

    const searched = harness({
      pages: [both],
      answers: [pick("CLICK", "2", "1"), pick("DONE")],
    });
    await searched.autopilot.run(token, { goal: "Search" });
    expect(searched.acted).toEqual([{ id: "e2" }]);
  });

  test("done is only taken on a page that hasn't changed; blocked says why", async () => {
    let checks = 0;
    const { autopilot } = harness({
      answers: [pick("DONE"), pick("BLOCKED")],
      fresh: () => checks++ > 0,
    });
    const result = await autopilot.run(token, { goal: "Sign in" });
    expect(result.stop).toBe("blocked");

    const framed = harness({
      pages: [page({ frames: 1 })],
      answers: [pick("BLOCKED")],
    });
    expect(
      (await framed.autopilot.run(token, { goal: "Pay" })).reason,
    ).toContain("frames");
  });

  test("a site where Jev keeps being overridden gets no autopilot", async () => {
    const { autopilot, asked } = harness({
      answers: [pick("DONE")],
      reliable: false,
    });
    const result = await autopilot.run(token, { goal: "Search" });
    expect(result.stop).toBe("unreliable");
    expect(asked).toEqual([]);
  });

  test("it stops at its step limit", async () => {
    const pages = Array.from({ length: 5 }, (_, i) =>
      page({ text: `page ${String(i)}` }),
    );
    const { autopilot, acted } = harness({
      pages,
      answers: Array.from({ length: 5 }, () => pick("CLICK", "2")),
    });
    const result = await autopilot.run(token, { goal: "Search", maxSteps: 2 });
    expect(acted).toHaveLength(2);
    expect(result.stop).toBe("max_steps");
    expect(autopilotLimits.maxSteps).toBe(60);
  });

  test("its picks are judged by the agent's next move: going back overrides them", async () => {
    const pages = [page(), page({ text: "Results" })];
    const { autopilot, outcomes } = harness({
      pages,
      answers: [pick("CLICK", "2"), pick("DONE")],
    });
    await autopilot.run(token, { goal: "Search" });
    autopilot.observe(token, "navigate", { back: true });
    expect(outcomes).toEqual([
      {
        decisions: [
          { id: "jev_1", action: "click [2] Go" },
          { id: "jev_2", action: null },
        ],
        outcome: "overridden",
      },
    ]);
  });
});
