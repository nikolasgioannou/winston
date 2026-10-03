/**
 * `bun run eval:replay`: runs real failures again (docs/design.md §6,
 * "Replays"). Each case is one model call's context; it's sent once more
 * with a candidate prompt (the repo's current one, the case's own, or a
 * Markdown file with the repo's tools) on a chosen model and effort, and a
 * judge scores the next move against the case's rubric. Paid (the dev
 * OpenRouter key); not in CI.
 *
 *   bun run eval:replay [--cases <dir>]… [--prompt current|stored|<file>]
 *     [--model sonnet|opus] [--effort low|medium|high] [--runs <n>]
 *     [--only <name,…>] [--out <file>]
 *
 * Held-out cases (`cases/`) always run; `--cases` adds a directory, such as
 * `src/evals/production` (the founder's cases from `eval:export`, which git
 * ignores).
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { systemPrompts, type ToolDefinition } from "@winston/prompts";
import {
  generateText,
  isStepCount,
  jsonSchema,
  tool,
  type ModelMessage,
  type ToolSet,
} from "ai";
import { z } from "zod";
import { browserHandoffDefinition } from "../tools/handoff.ts";
import { bashDefinition } from "../tools/bash.ts";
import { viewImageDefinition } from "../tools/view-image.ts";
import { attachDefinition } from "../tools/attach.ts";
import { delegateDefinition } from "../tools/delegate.ts";
import { endTurnDefinition } from "../front/reply.ts";
import { cacheBreakpoint, withRollingBreakpoint } from "../model/cache.ts";
import { replayCase, type ReplayCase } from "./case.ts";

const models = {
  sonnet: "anthropic/claude-sonnet-5",
  opus: "anthropic/claude-opus-5.5",
} as const;

/** The judge: careful, and cheap on a rubric and one move. */
const judgeModel = "anthropic/claude-opus-5.5";

const { values } = parseArgs({
  options: {
    cases: { type: "string", multiple: true, default: [] },
    prompt: { type: "string", default: "current" },
    model: { type: "string", default: "sonnet" },
    effort: { type: "string", default: "low" },
    runs: { type: "string", default: "1" },
    only: { type: "string" },
    out: { type: "string" },
  },
});
const model = models[z.enum(["sonnet", "opus"]).parse(values.model)];
const effort = z.enum(["low", "medium", "high"]).parse(values.effort);
const runs = Math.max(1, Number(values.runs));
const only = values.only?.split(",");

const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY ?? "",
});
const settings = (effortLevel: string) => ({
  provider: {
    order: ["anthropic"],
    allow_fallbacks: false,
    data_collection: "deny" as const,
  },
  reasoning: { effort: effortLevel },
  usage: { include: true },
});

/** The front of house's prompt as the repo has it now, or a candidate's text. */
const current = {
  system:
    values.prompt === "current" || values.prompt === "stored"
      ? systemPrompts["front-of-house"]
      : await readFile(values.prompt, "utf8"),
  tools: [
    bashDefinition("front"),
    viewImageDefinition,
    attachDefinition,
    delegateDefinition,
    browserHandoffDefinition,
    endTurnDefinition,
  ],
};

async function loadCases() {
  const dirs = [join(import.meta.dir, "cases"), ...values.cases];
  const cases: ReplayCase[] = [];
  for (const dir of dirs)
    for (const file of (await readdir(dir)).filter((f) => f.endsWith(".json")))
      cases.push(
        replayCase.parse(
          JSON.parse(await readFile(join(dir, file), "utf8")),
        ) as unknown as ReplayCase,
      );
  return cases.filter((c) => !only || only.includes(c.name));
}

/**
 * The history without reasoning parts: their signatures belong to the
 * model that wrote them, and every arm should see the same history.
 */
const withoutReasoning = (messages: ModelMessage[]) =>
  messages.map((message) =>
    message.role === "assistant" && Array.isArray(message.content)
      ? {
          ...message,
          content: message.content.filter((part) => part.type !== "reasoning"),
        }
      : message,
  );

/** Definitions as tools the model can call (nothing runs: one step only). */
const toolsOf = (definitions: ToolDefinition[]) =>
  Object.fromEntries(
    definitions.map((d) => [
      d.name,
      tool({
        description: d.description,
        inputSchema: jsonSchema(
          d.inputSchema as Parameters<typeof jsonSchema>[0],
        ),
      }),
    ]),
  ) as ToolSet;

const costOf = (metadata: unknown) =>
  (metadata as { openrouter?: { usage?: { cost?: number } } } | undefined)
    ?.openrouter?.usage?.cost ?? 0;

/** One replay of a case: the move the model makes next. */
async function replay(c: ReplayCase) {
  const prompt = values.prompt === "stored" && c.system ? c : current;
  const result = await generateText({
    model: openrouter(model, settings(effort) as never),
    // Cached, so a case's later runs read its context back.
    instructions: cacheBreakpoint({ role: "system", content: prompt.system }),
    messages: withRollingBreakpoint(withoutReasoning(c.messages)),
    tools: toolsOf(prompt.tools),
    stopWhen: isStepCount(1),
    // Anthropic sometimes answers "Overloaded" for a while; the SDK backs off (2 s, 4 s, …).
    maxRetries: 6,
    timeout: 180_000,
  });
  return {
    move: {
      text: result.text,
      toolCalls: result.toolCalls.map((call) => ({
        tool: call.toolName,
        input: call.input as unknown,
      })),
    },
    cost: costOf(result.finalStep.providerMetadata),
    // The model's own time, without retries' waits.
    ms: result.finalStep.performance.responseTimeMs,
  };
}

const verdict = z.object({ pass: z.boolean(), reason: z.string() });

/** The judge's verdict on a move, against the case's rubric. */
async function judge(
  c: ReplayCase,
  move: Awaited<ReturnType<typeof replay>>["move"],
) {
  const result = await generateText({
    model: openrouter(judgeModel, settings("low") as never),
    instructions:
      'You judge one move by an AI assistant, Winston, against a rubric. The move is what he did next: text he wrote and tool calls (shell commands he ran). Judge only against the rubric. Answer with JSON only: {"pass": true or false, "reason": "one sentence"}.',
    prompt: JSON.stringify({ rubric: c.rubric, move }),
    maxRetries: 6,
  });
  const json = /\{[\s\S]*\}/.exec(result.text)?.[0] ?? "{}";
  const parsed = verdict.safeParse(JSON.parse(json));
  return {
    ...(parsed.success
      ? parsed.data
      : {
          pass: false,
          reason: `Unreadable verdict: ${result.text.slice(0, 200)}`,
        }),
    cost: costOf(result.finalStep.providerMetadata),
  };
}

const cases = await loadCases();
console.log(
  `${String(cases.length)} cases × ${String(runs)} on ${model} (${effort}), prompt: ${values.prompt}\n`,
);
const results: {
  name: string;
  cause: string;
  source: string;
  /** Undefined when the run couldn't happen (the error is the reason). */
  pass: boolean | undefined;
  reason: string;
  move: unknown;
  ms: number | undefined;
}[] = [];
/** Everything spent, and the replays alone (the arm's own cost, without the judge). */
let spent = 0;
let replaySpent = 0;
/** One run of a case, judged. */
async function run(c: ReplayCase) {
  try {
    const { move, cost, ms } = await replay(c);
    const scored = await judge(c, move);
    spent += cost + scored.cost;
    replaySpent += cost;
    return { pass: scored.pass, reason: scored.reason, move, ms };
  } catch (error) {
    return {
      pass: undefined,
      reason: `Couldn't run: ${error instanceof Error ? error.message : String(error)}`,
      move: null,
      ms: undefined,
    };
  }
}
/** Passes out of the runs that happened, and how many couldn't. */
const score = (outcomes: { pass: boolean | undefined }[]) => {
  const ran = outcomes.filter((o) => o.pass !== undefined);
  const errors = outcomes.length - ran.length;
  return {
    passed: ran.filter((o) => o.pass).length,
    ran: ran.length,
    text: `${String(ran.filter((o) => o.pass).length)}/${String(ran.length)}${errors > 0 ? ` (${String(errors)} couldn't run)` : ""}`,
  };
};
for (const c of cases) {
  // The first run writes the cache; the rest read it, together.
  const first = await run(c);
  const outcomes = [
    first,
    ...(await Promise.all(Array.from({ length: runs - 1 }, () => run(c)))),
  ];
  for (const outcome of outcomes)
    results.push({
      name: c.name,
      cause: c.cause,
      source: c.source,
      ...outcome,
    });
  const { passed, ran, text } = score(outcomes);
  console.log(
    `${ran > 0 && passed === ran ? "✓" : passed === 0 ? "✗" : "~"} ${c.name} (${c.source}, ${c.cause}): ${text}`,
  );
  for (const outcome of outcomes.filter((o) => o.pass !== true))
    console.log(`    ${outcome.reason}`);
}
const total = (source: string) =>
  score(results.filter((r) => r.source === source)).text;
const times = results
  .flatMap((r) => (r.ms === undefined ? [] : [r.ms]))
  .sort((a, b) => a - b);
const median = times[Math.floor(times.length / 2)] ?? 0;
console.log(
  `\nproduction ${total("production")}, held-out ${total("held-out")}; replays $${replaySpent.toFixed(2)} (median ${(median / 1000).toFixed(1)}s), $${spent.toFixed(2)} with judging`,
);
if (values.out)
  await writeFile(
    values.out,
    JSON.stringify({ model, effort, prompt: values.prompt, results }, null, 2),
  );
