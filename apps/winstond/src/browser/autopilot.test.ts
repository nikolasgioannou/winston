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

const choice = (ids: string[], selected: string, confidence = 1) => ({
  type: "choice",
  choice: selected,
  confidence,
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
  (
    operation: string,
    target?: string,
    commits = "none",
    confidence = 1,
  ): Answer =>
  (questions) => ({
    operation: choice(
      Object.keys(questions.operation?.criteria ?? {}),
      operation,
      confidence,
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

/** The step picker's answer. */
const step = (
  operation: string,
  target: string | null = null,
  extra: { text?: string | null; commits?: boolean } = {},
) => ({
  operation,
  target,
  text: extra.text ?? null,
  commits: extra.commits ?? false,
});

/** Autopilot over a scripted page reader and backend. */
function harness({
  pages = [page()],
  answers,
  picks = [],
  texts = ["dune"],
  fresh = () => true,
  act = () => Promise.resolve(),
  observe,
  reliable = true,
  jevDown = false,
}: {
  pages?: FastPage[];
  answers: Answer[];
  /** The step picker's answers in turn; null (or none left) is unavailable. */
  picks?: (ReturnType<typeof step> | null)[];
  texts?: (string | null)[];
  fresh?: () => boolean;
  act?: (action: FastAction, text?: string) => Promise<void>;
  observe?: (index: number) => Promise<FastPage>;
  reliable?: boolean;
  jevDown?: boolean;
}) {
  const acted: { id: string; text?: string }[] = [];
  const asked: Questions[] = [];
  const picked: Record<string, unknown>[] = [];
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
      if (request.path === "/v1/jev/pick") {
        picked.push(body);
        const answer = picks.shift();
        return Promise.resolve(
          answer
            ? {
                status: 200,
                body: JSON.stringify({
                  decisionId: `pick_${String(picked.length)}`,
                  pick: answer,
                }),
              }
            : { status: 503, body: "{}" },
        );
      }
      if (jevDown) return Promise.resolve({ status: 503, body: "{}" });
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
  return {
    autopilot,
    entry,
    acted,
    asked,
    picked,
    written,
    outcomes,
    reads: () => reads,
  };
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

  test("a click can't take a target from another head: the step goes to the picker", async () => {
    const { autopilot, acted, asked, picked } = harness({
      answers: [
        (questions) => ({
          ...pick("CLICK")(questions),
          click_target: choice(["1", "2", "999"], "999"),
          type_text_target: choice(["1"], "1"),
        }),
        pick("DONE"),
      ],
    });
    const result = await autopilot.run(token, { goal: "Search for dune" });
    expect(picked[0]?.reason).toBe("Jev's answer didn't check out.");
    // No picker here: Jev is asked again, and nothing was done meanwhile.
    expect(asked).toHaveLength(2);
    expect(result.stop).toBe("done");
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

  test("nothing is typed on a stale page: it's read again, and the same step is tried once more if its element is still there", async () => {
    let freshness = false;
    const { autopilot, acted, asked, reads } = harness({
      pages: [page(), page(), page({ text: "Results" })],
      answers: [pick("TYPE_TEXT", "1"), pick("DONE")],
      fresh: () => {
        const was = freshness;
        freshness = true;
        return was;
      },
    });
    const result = await autopilot.run(token, { goal: "Search for dune" });
    // Decided once, typed on the fresh read, not on the stale one.
    expect(asked).toHaveLength(2);
    expect(acted).toEqual([{ id: "e1", text: "dune" }]);
    expect(reads()).toBe(3);
    expect(result.stop).toBe("done");
  });

  test("a step the picker decided isn't decided again when the page moves on: it's retried once, then given up", async () => {
    let stale = 2;
    const retried = harness({
      pages: [page(), page(), page({ text: "Results" })],
      answers: [pick("BLOCKED"), pick("DONE")],
      picks: [step("CLICK", "2")],
      act: () =>
        stale-- > 1
          ? Promise.reject(new StalePage("the map moved"))
          : Promise.resolve(),
    });
    await retried.autopilot.run(token, { goal: "Search" });
    expect(retried.picked).toHaveLength(1);
    expect(retried.acted).toEqual([{ id: "e3" }]);

    // Gone stale twice: the step is decided afresh.
    let failures = 2;
    const decidedAgain = harness({
      pages: [page(), page(), page(), page({ text: "Results" })],
      answers: [pick("BLOCKED"), pick("BLOCKED"), pick("DONE")],
      picks: [step("CLICK", "2"), step("CLICK", "2")],
      act: () =>
        failures-- > 0
          ? Promise.reject(new StalePage("the map moved"))
          : Promise.resolve(),
    });
    await decidedAgain.autopilot.run(token, { goal: "Search" });
    expect(decidedAgain.picked).toHaveLength(2);
    expect(decidedAgain.acted).toEqual([{ id: "e3" }]);
  });

  test("text written for a field is reused only when its context is the same", async () => {
    let failures = 1;
    const run = async (changed: boolean) => {
      const pages = [
        page(),
        page({ text: changed ? "Different page" : "Search" }),
        page({ text: "Results" }),
      ];
      const h = harness({
        pages,
        answers: [pick("TYPE_TEXT", "1"), pick("DONE")],
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

  test("three actions in a row that change nothing stop the run, the picker's included", async () => {
    const { autopilot, acted, asked, picked } = harness({
      answers: Array.from({ length: 5 }, () => pick("CLICK", "2")),
      picks: [step("CLICK", "2"), step("CLICK", "2")],
    });
    const result = await autopilot.run(token, { goal: "Search" });
    expect(acted).toHaveLength(3);
    // Jev wanting the same click again, after it changed nothing, goes to the picker.
    expect(asked).toHaveLength(3);
    expect(picked).toHaveLength(2);
    expect(picked[0]?.reason).toBe(
      "Jev wants to repeat a step that changed nothing.",
    );
    expect(result.stop).toBe("no_progress");
  });

  test("a click that makes the page ask for files stops the run there, for upload", async () => {
    const drive = page({
      actions: [
        {
          id: "e5",
          kind: "click",
          label: "File upload",
          role: "menuitem",
          value: "",
          node: 30,
        },
      ],
    });
    const run = harness({
      pages: [drive],
      answers: [pick("CLICK", "1"), pick("CLICK", "1")],
      act: () => {
        // Chrome reports the picker the click opened (windows.ts).
        run.entry.fileChooser = {
          multiple: true,
          backendNodeId: 16,
          sessionId: "s1",
        };
        return Promise.resolve();
      },
    });
    // One left from before doesn't count: only what this run opens does.
    run.entry.fileChooser = {
      multiple: false,
      backendNodeId: 4,
      sessionId: "s1",
    };
    const result = await run.autopilot.run(token, {
      goal: "Click New, then File upload, and upload the receipts",
    });
    expect(run.acted).toEqual([{ id: "e5" }]);
    expect(run.asked).toHaveLength(1);
    expect(result.stop).toBe("blocked");
    expect(result.reason).toBe(
      "The page is asking for files (it takes several): give them with winston browser upload <path…>.",
    );
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

  test("on a page that never stops changing, done twice in a row on two reads stands", async () => {
    const { autopilot, asked, reads } = harness({
      answers: [pick("DONE"), pick("DONE"), pick("DONE")],
      fresh: () => false,
    });
    const result = await autopilot.run(token, { goal: "Show the prices" });
    expect(result.stop).toBe("done");
    expect(asked).toHaveLength(2);
    expect(reads()).toBe(2);
  });

  test("where Jev keeps being overridden, the step picker decides every step", async () => {
    const { autopilot, asked, picked, acted } = harness({
      pages: [page(), page({ text: "Results" })],
      answers: [pick("DONE")],
      picks: [step("CLICK", "2"), step("DONE")],
      reliable: false,
    });
    const result = await autopilot.run(token, { goal: "Search" });
    expect(asked).toEqual([]);
    expect(picked.map((p) => p.reason)).toEqual([
      "Jev keeps being overridden on this site.",
      "Jev keeps being overridden on this site.",
    ]);
    expect(acted).toEqual([{ id: "e3" }]);
    expect(result).toMatchObject({ stop: "done", escalated: 2 });
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

describe("one way to act: the step picker takes what Jev isn't sure of", () => {
  test("an unsure done goes to the picker, which sees the same page, operations and rules", async () => {
    const { autopilot, acted, picked } = harness({
      pages: [page(), page({ text: "Results" })],
      answers: [pick("DONE", undefined, "none", 0.3), pick("DONE")],
      picks: [step("CLICK", "2")],
    });
    const result = await autopilot.run(token, { goal: "Search for dune" });
    expect(acted).toEqual([{ id: "e3" }]);
    const asked = picked[0] ?? {};
    expect(asked.reason).toBe("Jev isn't sure it's done (confidence 0.30).");
    expect(asked.goal).toBe("Search for dune");
    expect(Object.keys(asked.operations as object)).toContain("CLICK");
    expect(JSON.stringify(asked.state)).toContain("Go");
    expect(String(asked.rules)).toContain(nextActionRules.slice(0, 40));
    expect(result).toMatchObject({ stop: "done", escalated: 1 });
    expect(result.page?.text).toBe("Results");
  });

  test("a pick Jev isn't confident of still stands: confidence alone doesn't call the picker", async () => {
    const { autopilot, acted, picked } = harness({
      pages: [page(), page({ text: "Results" })],
      answers: [pick("CLICK", "2", "none", 0.24), pick("DONE")],
    });
    await autopilot.run(token, { goal: "Search" });
    expect(acted).toEqual([{ id: "e3" }]);
    expect(picked).toEqual([]);
  });

  test("the picker's text is typed as is; a value it doesn't have stops the run", async () => {
    const typed = harness({
      pages: [page(), page({ text: "Results" })],
      answers: [pick("BLOCKED"), pick("DONE")],
      picks: [step("TYPE_TEXT", "1", { text: "dune" })],
    });
    await typed.autopilot.run(token, { goal: "Search for dune" });
    expect(typed.acted).toEqual([{ id: "e1", text: "dune" }]);
    expect(typed.written).toEqual([]);

    const missing = harness({
      answers: [pick("BLOCKED")],
      picks: [step("TYPE_TEXT", "1", { text: null })],
    });
    const result = await missing.autopilot.run(token, {
      goal: "Fill in my passport number",
    });
    expect(result.stop).toBe("needs_value");
    expect(missing.acted).toEqual([]);
  });

  test("a step the picker says commits waits for --commit, which takes that one step and stops", async () => {
    const answers = () => [pick("BLOCKED")];
    const picks = () => [step("CLICK", "2", { commits: true })];
    const held = harness({ answers: answers(), picks: picks() });
    const stopped = await held.autopilot.run(token, { goal: "Send it" });
    expect(stopped.stop).toBe("commits");
    expect(stopped.reason).toContain("--commit");
    expect(held.acted).toEqual([]);

    const approved = harness({ answers: answers(), picks: picks() });
    const committed = await approved.autopilot.run(token, {
      goal: "Send it",
      commit: true,
    });
    expect(approved.acted).toEqual([{ id: "e3" }]);
    expect(committed.stop).toBe("committed");
  });

  test("when Jev is down the picker decides; when neither can, it stops", async () => {
    const down = harness({
      pages: [page(), page({ text: "Results" })],
      answers: [],
      picks: [step("CLICK", "2"), step("DONE")],
      jevDown: true,
    });
    const result = await down.autopilot.run(token, { goal: "Search" });
    expect(down.acted).toEqual([{ id: "e3" }]);
    expect(down.picked[0]?.reason).toBe("Jev isn't available.");
    expect(result.stop).toBe("done");

    const neither = harness({ answers: [], jevDown: true });
    expect((await neither.autopilot.run(token, { goal: "Search" })).stop).toBe(
      "unavailable",
    );
  });

  test("the picker's answer is checked like Jev's; one that doesn't check out leaves Jev's pick", async () => {
    const { autopilot, acted } = harness({
      pages: [page(), page({ text: "Results" })],
      answers: [pick("CLICK", "1", "none", 0.3), pick("DONE")],
      // A target that isn't one of CLICK's.
      picks: [step("CLICK", "9")],
    });
    await autopilot.run(token, { goal: "Open search" });
    expect(acted).toEqual([{ id: "e2" }]);
  });

  test("Jev's blocked is checked by the picker, which can find a way on", async () => {
    const { autopilot, acted } = harness({
      pages: [page(), page({ text: "Results" })],
      answers: [pick("BLOCKED"), pick("DONE")],
      picks: [step("CLICK", "2")],
    });
    const result = await autopilot.run(token, { goal: "Search" });
    expect(acted).toEqual([{ id: "e3" }]);
    expect(result.stop).toBe("done");
  });

  test("keys are offered as operations, and one that commits waits like a click", async () => {
    const field: FastAction = {
      id: "e1",
      kind: "fill",
      label: "Message",
      role: "textbox",
      value: "On my way",
      node: 7,
    };
    const enter: FastAction = {
      id: "press_enter",
      kind: "key",
      key: "Enter",
      label: "Press Enter in Message",
    };
    const chat = page({ actions: [field, enter] });
    const sends = harness({
      pages: [chat],
      answers: [pick("PRESS_ENTER", undefined, "PRESS_ENTER")],
    });
    const result = await sends.autopilot.run(token, { goal: "Send it" });
    expect(result.stop).toBe("commits");
    expect(sends.asked[0]?.commits?.criteria).toHaveProperty("PRESS_ENTER");
    expect(sends.acted).toEqual([]);

    const searches = harness({
      pages: [chat, page({ text: "Results" })],
      answers: [pick("PRESS_ENTER"), pick("DONE")],
    });
    await searches.autopilot.run(token, { goal: "Search" });
    expect(searches.acted).toEqual([{ id: "press_enter" }]);
  });
});
