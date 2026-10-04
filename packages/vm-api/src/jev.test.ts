import { describe, expect, test } from "bun:test";
import { costLedger, jevDecisions } from "@winston/db/schema";
import { inRollback, insertRun, insertUser, testDb } from "@winston/db/testing";
import {
  hedged,
  openRouterJev,
  parsePick,
  parseText,
  pickFormat,
  siteReliability,
  textRules,
} from "./jev.ts";
import { setupApi } from "./testing.ts";

const db = await testDb();

const ask = {
  state: {
    goal: "Open the first result",
    page: "e1 link 'Home'\ne2 link 'Bun'",
  },
  questions: {
    action: {
      type: "choice",
      instructions: "Which element should be clicked next?",
      criteria: { e1: "link 'Home'", e2: "link 'Bun'" },
    },
    goal_done: { type: "noul", instructions: "The goal is met." },
  },
  domain: "example.com",
};

const answers = {
  action: {
    type: "choice",
    choice: "e2",
    probabilities: { e1: 0.1, e2: 0.9 },
    confidence: 0.8,
  },
  goal_done: { type: "noul", noul: 0.1 },
};

/** A stand-in for OpenRouter's decisions API, recording what it was sent. */
function fakeOpenRouter(reply: () => Response | Promise<Response>) {
  const sent: { url: string; headers: Headers; body: unknown }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    sent.push({
      url,
      headers: new Headers(init.headers),
      body: JSON.parse(init.body as string),
    });
    return reply();
  }) as unknown as typeof fetch;
  return { sent, jev: openRouterJev({ apiKey: "sk-or-test", fetchImpl }) };
}

async function setup(
  tx: Parameters<typeof setupApi>[0],
  jev?: ReturnType<typeof fakeOpenRouter>["jev"],
) {
  const user = await insertUser(tx);
  const run = await insertRun(tx, user.id, { kind: "background" });
  const call = setupApi(tx, {}, jev ? { jev } : {}).as(
    user.id,
    run.id,
    "background",
  );
  return { user, run, call };
}

describe("the Jev proxy", () => {
  test("forwards the questions with the backend's key, logs the decision and charges its cost", async () => {
    await inRollback(db, async (tx) => {
      const openRouter = fakeOpenRouter(() =>
        Response.json({
          model: "typesafe/jev-1.13-20260917",
          answers,
          usage: { input_tokens: 444, output_tokens: 68, cost: 0.000018648 },
        }),
      );
      const { user, run, call } = await setup(tx, openRouter.jev);
      const response = await call("/v1/jev/decide", {
        method: "POST",
        body: ask,
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        decisionId: string;
        answers: unknown;
      };
      expect(body.decisionId).toStartWith("jev_");
      expect(body.answers).toEqual(answers);

      const [sent] = openRouter.sent;
      expect(sent?.url).toBe("https://openrouter.ai/api/alpha/decisions");
      expect(sent?.headers.get("Authorization")).toBe("Bearer sk-or-test");
      expect(sent?.body).toEqual({
        model: "typesafe/jev-1.13",
        state: ask.state,
        questions: ask.questions,
      });

      const [decision] = await tx.select().from(jevDecisions);
      expect(decision).toMatchObject({
        id: body.decisionId,
        userId: user.id,
        runId: run.id,
        domain: "example.com",
        answer: answers,
        model: "typesafe/jev-1.13-20260917",
        error: null,
        outcome: "unknown",
      });
      expect(decision?.question).toEqual({
        state: ask.state,
        questions: ask.questions,
      });
      const [cost] = await tx.select().from(costLedger);
      expect(cost).toMatchObject({
        userId: user.id,
        runId: run.id,
        category: "jev",
        costUsd: "0.000019",
      });
    });
  });

  test("a failed or incomplete answer is logged and reported as unavailable, with nothing charged", async () => {
    await inRollback(db, async (tx) => {
      let reply = () => new Response("busy", { status: 503 });
      const openRouter = fakeOpenRouter(() => reply());
      const { call } = await setup(tx, openRouter.jev);
      const failed = await call("/v1/jev/decide", {
        method: "POST",
        body: ask,
      });
      expect(failed.status).toBe(503);
      expect(await failed.json()).toMatchObject({
        error: { code: "unavailable", message: "Jev answered 503." },
      });

      reply = () => Response.json({ answers: { action: answers.action } });
      const partial = await call("/v1/jev/decide", {
        method: "POST",
        body: ask,
      });
      expect(partial.status).toBe(503);

      const errors = (await tx.select().from(jevDecisions)).map((d) => d.error);
      expect(errors.sort()).toEqual([
        "Jev answered 503.",
        "Jev's answer was incomplete.",
      ]);
      expect(await tx.select().from(costLedger)).toEqual([]);
    });
  });

  test("without Jev set up, or with too many options, it says so", async () => {
    await inRollback(db, async (tx) => {
      const { call } = await setup(tx);
      const off = await call("/v1/jev/decide", { method: "POST", body: ask });
      expect(off.status).toBe(503);

      const openRouter = fakeOpenRouter(() => Response.json({ answers }));
      const { call: withJev } = await setup(tx, openRouter.jev);
      const criteria = Object.fromEntries(
        Array.from({ length: 256 }, (_, i) => [`e${String(i)}`, "link"]),
      );
      const tooMany = await withJev("/v1/jev/decide", {
        method: "POST",
        body: {
          ...ask,
          questions: {
            action: { type: "choice", criteria, instructions: "Which one?" },
          },
        },
      });
      expect(tooMany.status).toBe(400);
      expect(openRouter.sent).toEqual([]);
    });
  });

  test("the text helper writes a field's value with Mercury, keeping no data, and logs and charges it", async () => {
    await inRollback(db, async (tx) => {
      const openRouter = fakeOpenRouter(() =>
        Response.json({
          model: "inception/mercury-2.5-20260908",
          choices: [{ message: { content: '{"text": "Zurich"}' } }],
          usage: { cost: 0.00001476 },
        }),
      );
      const { user, call } = await setup(tx, openRouter.jev);
      const context = {
        goal: "Search flights from Zurich to London on 2026-10-20",
        field: { label: "Where from?", role: "combobox", value: "" },
        page: { title: "Google Flights", text: "Where from? Where to?" },
        recent_actions: [],
      };
      const response = await call("/v1/jev/text", {
        method: "POST",
        body: { context, domain: "google.com" },
      });
      expect(await response.json()).toMatchObject({ text: "Zurich" });
      const [sent] = openRouter.sent;
      expect(sent?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
      expect(sent?.body).toMatchObject({
        model: "inception/mercury-2.5",
        response_format: { type: "json_object" },
        reasoning: { enabled: false },
        provider: { data_collection: "deny" },
        messages: [
          { role: "system", content: textRules },
          { role: "user", content: JSON.stringify(context) },
        ],
      });
      const [logged] = await tx.select().from(jevDecisions);
      expect(logged).toMatchObject({
        userId: user.id,
        domain: "google.com",
        question: { textHelper: context },
        answer: { text: "Zurich" },
        model: "inception/mercury-2.5-20260908",
      });
      const [cost] = await tx.select().from(costLedger);
      expect(cost).toMatchObject({ category: "jev", costUsd: "0.000015" });
    });
  });

  test("a value the goal doesn't give comes back null; anything but exactly {text} is no answer", () => {
    expect(parseText('{"text": null}')).toBeNull();
    expect(parseText('{"text": "Zurich"}')).toBe("Zurich");
    for (const content of [
      "Thinking: Zurich",
      '{"text":"Zurich","extra":true}',
      '{"text":123}',
      '{"text":"  "}',
      JSON.stringify({ text: "x".repeat(2_001) }),
    ])
      expect(() => parseText(content)).toThrow();
  });

  test("the step picker decides a step on Sonnet, pinned and keeping no data, and logs and charges it", async () => {
    await inRollback(db, async (tx) => {
      const openRouter = fakeOpenRouter(() =>
        Response.json({
          model: "anthropic/claude-sonnet-5-20260801",
          choices: [
            {
              message: {
                content:
                  'Looking at the page, the date isn\'t set yet.\n{"operation": "CLICK", "target": "4", "text": null, "commits": false}',
              },
            },
          ],
          usage: { cost: 0.0042 },
        }),
      );
      const { user, call } = await setup(tx, openRouter.jev);
      const body = {
        domain: "google.com",
        goal: "Leave at 5pm tomorrow",
        state: { page: { url: "https://maps.google.com/", text: "Depart at" } },
        operations: { CLICK: "Click an element.", DONE: "Done." },
        rules: "Advance the goal with one operation.",
        reason: "Jev isn't sure (confidence 0.25).",
      };
      const response = await call("/v1/jev/pick", { method: "POST", body });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        pick: { operation: "CLICK", target: "4", text: null, commits: false },
        model: "anthropic/claude-sonnet-5-20260801",
      });
      const [sent] = openRouter.sent;
      expect(sent?.body).toMatchObject({
        model: "anthropic/claude-sonnet-5",
        reasoning: { effort: "low" },
        provider: {
          order: ["anthropic"],
          allow_fallbacks: false,
          data_collection: "deny",
        },
      });
      const messages = (sent?.body as { messages: { content: string }[] })
        .messages;
      expect(messages[0]?.content).toStartWith(pickFormat);
      expect(messages[0]?.content).toContain(body.rules);
      expect(JSON.parse(messages[1]?.content ?? "{}")).toMatchObject({
        goal: body.goal,
        why_you: body.reason,
        operations: body.operations,
        page: body.state.page,
      });
      const [logged] = await tx.select().from(jevDecisions);
      expect(logged).toMatchObject({
        userId: user.id,
        domain: "google.com",
        answer: { operation: "CLICK", target: "4" },
      });
      expect(logged?.question).toHaveProperty("picker");
      const [cost] = await tx.select().from(costLedger);
      expect(cost).toMatchObject({ category: "jev", costUsd: "0.004200" });
    });
  });

  test("the step picker's answer is its first JSON object with the right shape; anything else is no answer", () => {
    expect(
      parsePick(
        '{"operation":"TYPE_TEXT","target":"2","text":"dune","commits":false}',
      ),
    ).toEqual({
      operation: "TYPE_TEXT",
      target: "2",
      text: "dune",
      commits: false,
    });
    expect(
      parsePick('```json\n{"operation":"DONE","commits":false}\n```'),
    ).toEqual({ operation: "DONE", target: null, text: null, commits: false });
    for (const content of [
      "Click the date.",
      '{"operation":"CLICK","target":"4"}',
      '{"operation":"","commits":false}',
      '{"operation":"CLICK","target":4,"commits":false}',
      JSON.stringify({
        operation: "TYPE_TEXT",
        text: "x".repeat(2_001),
        commits: false,
      }),
    ])
      expect(() => parsePick(content)).toThrow();
  });

  test("a failed step picker is logged and reported as unavailable, and its picks don't count against Jev on a site", async () => {
    await inRollback(db, async (tx) => {
      const openRouter = fakeOpenRouter(
        () => new Response("busy", { status: 529 }),
      );
      const { user, call } = await setup(tx, openRouter.jev);
      const response = await call("/v1/jev/pick", {
        method: "POST",
        body: {
          goal: "Search",
          state: {},
          operations: { DONE: "Done." },
          rules: "",
          reason: "Jev isn't available.",
        },
      });
      expect(response.status).toBe(503);
      const [logged] = await tx.select().from(jevDecisions);
      expect(logged?.error).toBe("The step picker answered 529.");
      expect(await tx.select().from(costLedger)).toEqual([]);

      for (let i = 0; i < siteReliability.minDecided; i++)
        await tx.insert(jevDecisions).values({
          userId: user.id,
          runId: null,
          domain: "shop.example",
          question: { picker: {} },
          outcome: "overridden",
          latencyMs: 2_000,
        });
      const site = (await (
        await call("/v1/jev/sites/shop.example")
      ).json()) as {
        reliable: boolean;
        decided: number;
      };
      expect(site).toMatchObject({ reliable: true, decided: 0 });
    });
  });

  test("a request that doesn't answer is backed up by a second, and the first good answer wins", async () => {
    const aborted: number[] = [];
    let calls = 0;
    const hangThenAnswer = (signal: AbortSignal) => {
      const call = calls++;
      signal.addEventListener("abort", () => aborted.push(call));
      return call === 0
        ? new Promise<string>(() => undefined)
        : Promise.resolve("second");
    };
    expect(await hedged(hangThenAnswer, 20)).toBe("second");
    expect(aborted.sort()).toEqual([0, 1]);

    // A fast failure starts the backup at once, without waiting.
    calls = 0;
    const started = Date.now();
    const failThenAnswer = () =>
      calls++ === 0
        ? Promise.reject(new Error("not JSON"))
        : Promise.resolve("backup");
    expect(await hedged(failThenAnswer, 10_000)).toBe("backup");
    expect(Date.now() - started).toBeLessThan(1_000);

    // Both failing reports the last failure.
    const failing = () => Promise.reject(new Error("down"));
    expect(await hedged(failing, 10).catch((e: unknown) => e)).toBeInstanceOf(
      Error,
    );
  });

  test("outcomes are recorded on the caller's own decisions, and a site turns unreliable when most picks are overridden", async () => {
    await inRollback(db, async (tx) => {
      const { user, call } = await setup(tx);
      const other = await insertUser(tx);
      const insert = (
        userId: string,
        outcome: "verified" | "overridden" | "unknown",
        domain = "shop.example",
      ) =>
        tx
          .insert(jevDecisions)
          .values({
            userId,
            runId: null,
            domain,
            question: {},
            outcome,
            latencyMs: 300,
          })
          .returning({ id: jevDecisions.id })
          .then((rows) => rows[0]?.id ?? "");
      const mine = await insert(user.id, "unknown");
      const theirs = await insert(other.id, "unknown");
      const recorded = await call("/v1/jev/outcome", {
        method: "POST",
        body: {
          decisions: [
            { id: mine, action: 'click e3 (link "Bun")' },
            { id: theirs, action: null },
          ],
          outcome: "verified",
        },
      });
      expect(recorded.status).toBe(200);
      const rows = await tx.select().from(jevDecisions);
      expect(rows.find((r) => r.id === mine)).toMatchObject({
        outcome: "verified",
        action: 'click e3 (link "Bun")',
      });
      expect(rows.find((r) => r.id === theirs)?.outcome).toBe("unknown");

      const site = async () =>
        (await (await call("/v1/jev/sites/shop.example")).json()) as {
          reliable: boolean;
          decided: number;
        };
      // Too few decided picks to judge: still on.
      for (let i = 0; i < 3; i++) await insert(user.id, "overridden");
      expect(await site()).toMatchObject({ reliable: true, decided: 4 });
      for (let i = 0; i < siteReliability.minDecided; i++)
        await insert(user.id, "overridden");
      expect((await site()).reliable).toBe(false);
      // Another site is unaffected.
      expect(
        (
          (await (await call("/v1/jev/sites/other.example")).json()) as {
            reliable: boolean;
          }
        ).reliable,
      ).toBe(true);
    });
  });
});
