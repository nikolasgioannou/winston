/**
 * `bun run eval:export <name> <run_id> <step> <out_dir>`: copies a production
 * model call's context into a replay case file (docs/design.md §6,
 * "Replays"), through `bun run prod sql` (read-only). Production contexts
 * are the founder's data: run it with their go-ahead, into `src/evals/production/`,
 * which git ignores. The rubric and cause are filled in by hand afterwards.
 */
import { $ } from "bun";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReplayCase } from "./case.ts";

const [name, runId, stepText, outDir] = Bun.argv.slice(2);
if (!name || !runId || !stepText || !outDir) {
  console.error("usage: bun run eval:export <name> <run_id> <step> <out_dir>");
  process.exit(1);
}
const step = Number(stepText);
const ident = /^[a-z0-9_]+$/;
if (!ident.test(runId) || !Number.isInteger(step)) {
  console.error("That doesn't look like a run id and a step.");
  process.exit(1);
}

/** Rows of a read-only production query, from the ops task's output. */
async function rows<T>(query: string): Promise<T[]> {
  const output = await $`bun run prod sql ${query}`
    .cwd(join(import.meta.dir, "../../../.."))
    .quiet()
    .text();
  return output
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as T];
      } catch {
        return [];
      }
    });
}

/** Long text comes back in 2,000-character parts (log lines are split past 16 KB). */
const partSize = 2_000;
const partCount = (column: string) =>
  `greatest(1, ceil(length(${column}) / ${String(partSize)}.0)::int)`;

/** Where a text column's rows come from, and which column names each. */
interface Source {
  column: string;
  key: string;
  tables: string;
  where: string;
}

/**
 * A text column, whole, for each row of a source, in key order. The output
 * arrives through the ops task's logs, which can drop lines: each list
 * carries its own total, and parts that didn't arrive are asked for again.
 */
async function texts({ column, key, tables, where }: Source) {
  const tries = 5;
  // `count(*)` is a bigint, which arrives as a string.
  let expected: { key: string; parts: number; total: string }[] = [];
  for (let attempt = 0; attempt < tries; attempt++) {
    expected = await rows(
      `select ${key}::text as key, ${partCount(column)} as parts, count(*) over () as total from ${tables} where ${where} order by ${key}`,
    );
    if (expected.length === Number(expected[0]?.total ?? 0)) break;
  }
  if (expected.length !== Number(expected[0]?.total ?? 0))
    throw new Error(`Couldn't list every row after ${String(tries)} tries.`);
  const got = new Map<string, string[]>();
  const missing = () =>
    expected.filter(({ key: k, parts }) =>
      Array.from({ length: parts }).some(
        (_, i) => got.get(k)?.[i] === undefined,
      ),
    );
  for (let attempt = 0; attempt < tries && missing().length > 0; attempt++) {
    // Everything at first; then only the rows still missing a part.
    const only =
      attempt === 0
        ? ""
        : ` and ${key}::text in (${missing()
            .map(({ key: k }) => `'${k}'`)
            .join(", ")})`;
    const chunks = await rows<{ key: string; part: number; chunk: string }>(
      `select ${key}::text as key, g.i as part, substr(${column}, (g.i - 1) * ${String(partSize)} + 1, ${String(partSize)}) as chunk from ${tables}, generate_series(1, ${partCount(column)}) g(i) where ${where}${only}`,
    );
    for (const { key: k, part, chunk } of chunks) {
      const list = got.get(k) ?? [];
      list[part - 1] = chunk;
      got.set(k, list);
    }
  }
  if (missing().length > 0)
    throw new Error(
      `Parts of ${String(missing().length)} rows didn't arrive after ${String(tries)} tries.`,
    );
  return expected.map(({ key: k }) => (got.get(k) ?? []).join(""));
}

const [call] = await rows<{
  prompt_hash: string;
  from_id: string;
  to_id: string;
}>(
  `select prompt_hash, context_from_message_id as from_id, context_to_message_id as to_id from model_calls where run_id = '${runId}' and step = ${String(step)}`,
);
if (!call) throw new Error(`No model call for ${runId} step ${String(step)}`);
// The context as the front saw it: its own window's runs (§2).
const [[prompt], messages] = await Promise.all([
  texts({
    column: "p.content",
    key: "p.hash",
    tables: "prompt_versions p",
    where: `p.hash = '${call.prompt_hash}'`,
  }),
  texts({
    column: "m.content::text",
    key: "m.id",
    tables: "run_messages m join runs r on r.id = m.run_id",
    where: `r.user_id = (select user_id from runs where id = '${runId}') and r.kind = 'front' and (r.status = 'completed' or r.id = '${runId}') and m.id between ${call.from_id} and ${call.to_id}`,
  }),
]);
if (!prompt) throw new Error(`No prompt version ${call.prompt_hash}`);
const { system, tools } = JSON.parse(prompt) as {
  system: string;
  tools: ReplayCase["tools"];
};
const replay: ReplayCase = {
  name,
  cause: "time",
  source: "production",
  rubric: "TODO: what a good next move does, and what fails.",
  system,
  tools,
  messages: messages.map(
    (text) => JSON.parse(text) as ReplayCase["messages"][number],
  ),
};
await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, `${name}.json`), JSON.stringify(replay, null, 2));
console.log(
  `${name}: ${String(replay.messages.length)} messages → ${join(outDir, `${name}.json`)}`,
);
