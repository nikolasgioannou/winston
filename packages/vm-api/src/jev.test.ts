import { describe, expect, test } from "bun:test";
import { costLedger, jevDecisions } from "@winston/db/schema";
import { inRollback, insertRun, insertUser, testDb } from "@winston/db/testing";
import { openRouterJev } from "./jev.ts";
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
          questions: { action: { type: "choice", criteria } },
        },
      });
      expect(tooMany.status).toBe(400);
      expect(openRouter.sent).toEqual([]);
    });
  });
});
