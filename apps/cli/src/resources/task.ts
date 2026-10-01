import type { InferResponseType } from "hono/client";
import { call, type ApiClient } from "../client.ts";
import type { Resource } from "../commands.ts";
import { CliError } from "../errors.ts";
import { standardFlags, textFlag, type FlagValues } from "../flags.ts";
import { json, list, shortTime } from "../output.ts";

/** Typed by the API itself (Hono RPC), so a change there breaks the build here. */
type Tasks = ApiClient["v1"]["tasks"];
type Page = InferResponseType<Tasks["$get"], 200>;
type Task = Page["tasks"][number];
type Detail = InferResponseType<Tasks[":id"]["$get"], 200>;
type Cancelled = InferResponseType<Tasks[":id"]["cancel"]["$post"], 200>;
type Resumed = InferResponseType<Tasks[":id"]["resume"]["$post"], 200>;

/** How long ago, roughly: `45s`, `12m`, `3h`, `2d`. */
export function ago(iso: string, now = Date.now()) {
  const seconds = Math.max(
    0,
    Math.round((now - new Date(iso).getTime()) / 1000),
  );
  if (seconds < 60) return `${String(seconds)}s`;
  if (seconds < 3600) return `${String(Math.floor(seconds / 60))}m`;
  if (seconds < 86_400) return `${String(Math.floor(seconds / 3600))}h`;
  return `${String(Math.floor(seconds / 86_400))}d`;
}

/** The brief's first line, cut short for a list. */
const firstLine = (brief: string) => {
  const line =
    brief
      .split("\n")
      .find((l) => l.trim())
      ?.trim() ?? "";
  const chars = Array.from(line);
  return chars.length > 100 ? `${chars.slice(0, 100).join("")}…` : line;
};

const statusWord = (task: Task) =>
  task.cancelRequested &&
  (task.status === "running" || task.status === "queued")
    ? "cancelling"
    : task.status;

/** One line per task: id, status, age, steps, the start of the brief. */
export const taskLine = (task: Task, now = Date.now()) =>
  [
    task.id,
    statusWord(task),
    `${ago(task.createdAt, now)} ago`,
    `${String(task.stepCount)} step${task.stepCount === 1 ? "" : "s"}`,
    firstLine(task.brief),
  ].join("  ");

function showPage(page: Page, flags: FlagValues) {
  if (flags.json === true) return json(page);
  const lines = page.tasks.map((task) => taskLine(task));
  if (lines.length === 0)
    return flags.status === undefined
      ? "No tasks running or parked."
      : "No tasks found.";
  return list(lines, {
    limit: lines.length,
    ...(page.cursor ? { nextCursor: page.cursor } : {}),
    narrow: "--status or --since",
  });
}

const triggerWords: Record<string, string> = {
  delegate: "delegated by the front of house",
  manual: "started by hand",
};

function showTask(detail: Detail, flags: FlagValues) {
  if (flags.json === true) return json(detail);
  const { task, timeZone } = detail;
  const indent = (text: string) =>
    text
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n");
  return [
    `${task.id} · ${statusWord(task)} · ${String(task.stepCount)} step${task.stepCount === 1 ? "" : "s"} · effort ${task.effort}`,
    `Started: ${shortTime(task.createdAt, timeZone)} (${triggerWords[task.trigger] ?? task.trigger})`,
    task.finishedAt
      ? `Finished: ${shortTime(task.finishedAt, timeZone)}`
      : undefined,
    task.cancelRequested && task.status === "running"
      ? "Cancelling: it stops at its next step and reports what it had done."
      : undefined,
    "Brief:",
    indent(task.brief),
    task.result ? "Result:" : undefined,
    task.result ? indent(task.result) : undefined,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

const needId = (args: string[]) => {
  const [id] = args;
  if (!id)
    throw CliError.usage(
      "Which task? Pass a task_ id.",
      "winston task list shows them.",
    );
  return id;
};

export const task: Resource = {
  name: "task",
  description: "Your background tasks: what's running, cancel, resume",
  ids: ["task"],
  verbs: [
    {
      name: "list",
      summary:
        "Background tasks, newest first (running and parked unless --status says otherwise)",
      flags: [
        {
          name: "status",
          value: "running|parked|done|failed|all",
          description: "Which tasks (default: running and parked)",
        },
        { ...standardFlags.since, description: "Started since this time" },
        standardFlags.limit,
        standardFlags.cursor,
      ],
      examples: [
        "winston task list",
        "winston task list --status all --since 1d",
      ],
      run: async ({ client, flags }) => {
        const entries = {
          status: textFlag(flags, "status"),
          since: textFlag(flags, "since"),
          limit:
            typeof flags.limit === "number" ? String(flags.limit) : undefined,
          cursor: textFlag(flags, "cursor"),
        };
        return showPage(
          await call<Page>(
            client.v1.tasks.$get({
              query: Object.fromEntries(
                Object.entries(entries).filter(
                  (entry): entry is [string, string] => entry[1] !== undefined,
                ),
              ),
            }),
          ),
          flags,
        );
      },
    },
    {
      name: "get",
      summary: "A task's brief, status, steps and result",
      usage: "<task_id>",
      flags: [],
      examples: ["winston task get task_01k5…"],
      run: async ({ client, flags, args }) =>
        showTask(
          await call<Detail>(
            client.v1.tasks[":id"].$get({ param: { id: needId(args) } }),
          ),
          flags,
        ),
    },
    {
      name: "cancel",
      summary:
        "Stop a task; a running one finishes its current step and reports what it had done",
      usage: "<task_id>",
      flags: [],
      examples: ["winston task cancel task_01k5…"],
      run: async ({ client, flags, args }) => {
        const result = await call<Cancelled>(
          client.v1.tasks[":id"].cancel.$post({ param: { id: needId(args) } }),
        );
        if (flags.json === true) return json(result);
        switch (result.outcome) {
          case "cancelled":
            return `Cancelled ${result.id}.`;
          case "cancelling":
            return `Cancelling ${result.id}: it stops at its next step, and its report of what it had done comes back to you.`;
          case "already_cancelling":
            return `${result.id} is already stopping.`;
          case "finished":
            return `${result.id} had already ended (${result.status}).`;
        }
      },
    },
    {
      name: "resume",
      summary: "Continue a parked task, passing on what the user said",
      usage: "<task_id>",
      flags: [
        {
          name: "note",
          value: "<text>",
          description: 'What to tell the task, e.g. "user says done"',
        },
      ],
      examples: ['winston task resume task_01k5… --note "user says done"'],
      run: async ({ client, flags, args }) => {
        const note = textFlag(flags, "note");
        const result = await call<Resumed>(
          client.v1.tasks[":id"].resume.$post({
            param: { id: needId(args) },
            json: note === undefined ? {} : { note },
          }),
        );
        return flags.json === true ? json(result) : `Resumed ${result.id}.`;
      },
    },
  ],
};
