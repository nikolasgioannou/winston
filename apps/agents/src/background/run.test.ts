import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import type { DbOrTx } from "@winston/db/client";
import {
  inboundItems,
  jobs,
  modelCalls,
  runMessages,
  runs,
} from "@winston/db/schema";
import { inRollback, insertUser, testDb } from "@winston/db/testing";
import { runStepJob } from "@winston/domain/jobs";
import { createLogger } from "@winston/shared/logger";
import type { ExecResult } from "@winston/domain/frames";
import type { ModelMessage } from "ai";
import { and, asc, eq } from "drizzle-orm";
import { localBlobStore } from "../blobs.ts";
import { dbModelCallSink } from "../model/log.ts";
import {
  fakeCompletion,
  fakeGateway,
  httpError,
  refusal,
  textReply,
  toolCallReply,
} from "../model/testing.ts";
import type { VmClient } from "../vm/gateway-client.ts";
import { fakeVmClient, testRunTokenSecret } from "../vm/testing.ts";
import { finishTask } from "@winston/db/tasks";
import { cancelTask, notRunBesideHandoff, resumeTask } from "@winston/db/tasks";
import {
  cancelledToolNote,
  cancelNote,
  capNote,
  compactNow,
  contextOf,
  interruptedNote,
  maxStepsPerRun,
  runBackgroundStep,
  startBackgroundRun,
  type BackgroundDeps,
} from "./run.ts";

const db = await testDb();
const logger = createLogger("agents-test", {
  pretty: false,
  destination: { write: () => undefined },
});
const blobs = localBlobStore(`${tmpdir()}/winston-test-blobs`);

/** A user with a background run started on `brief`, and deps over a scripted model. */
async function setup(
  tx: DbOrTx,
  replies: Record<string, unknown>[],
  vm: VmClient = fakeVmClient().client,
) {
  const user = await insertUser(tx, { timezone: "America/New_York" });
  const fake = fakeGateway({ replies, sink: dbModelCallSink(tx, logger) });
  const deps: BackgroundDeps = {
    db: tx,
    logger,
    gateway: fake.gateway,
    vm,
    runTokenSecret: testRunTokenSecret,
    webPublicUrl: "https://runwinston.com",
    blobs,
    retryDelayMs: 0,
  };
  const runId = await startBackgroundRun(tx, {
    userId: user.id,
    brief: "Find the lease and summarize the renewal terms.",
  });
  return { deps, runId, userId: user.id, requests: fake.requests };
}

const messagesOf = async (tx: DbOrTx, runId: string) =>
  (
    await tx
      .select({ content: runMessages.content })
      .from(runMessages)
      .where(eq(runMessages.runId, runId))
      .orderBy(asc(runMessages.seq))
  ).map((row) => row.content as ModelMessage);

const runOf = async (tx: DbOrTx, runId: string) =>
  (await tx.select().from(runs).where(eq(runs.id, runId)))[0];

/** Steps the run until it finishes (or `limit` steps), like the queue would. */
async function drive(deps: BackgroundDeps, runId: string, limit = 10) {
  const outcomes: string[] = [];
  for (let i = 0; i < limit; i += 1) {
    const outcome = await runBackgroundStep(deps, runId);
    outcomes.push(outcome);
    if (outcome !== "continued") break;
  }
  return outcomes;
}

const roles = (messages: ModelMessage[]) => messages.map((m) => m.role);

/** The message a promise rejects with (failing the test if it doesn't). */
async function failure(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(Error);
  return error instanceof Error ? error.message : "";
}

describe("background runs", () => {
  test("start queues the run with its brief and a first step", async () => {
    await inRollback(db, async (tx) => {
      const { runId } = await setup(tx, []);
      expect(runId).toStartWith("task_");
      expect(await runOf(tx, runId)).toMatchObject({
        kind: "background",
        status: "queued",
        brief: "Find the lease and summarize the renewal terms.",
      });
      const [first] = await messagesOf(tx, runId);
      expect(first?.content).toMatch(
        /^<task started_at="\d{4}-\d\d-\d\dT[\d:]+[-+]\d\d:\d\d \([A-Z][a-z]+day\)">\nFind the lease/,
      );
      const queued = await tx
        .select()
        .from(jobs)
        .where(eq(jobs.dedupeKey, runStepJob.dedupeKey(runId)));
      expect(queued).toHaveLength(1);
      expect(queued[0]?.payload).toEqual({ runId });
    });
  });

  test("checkpoints every step: the model's message, then its tools' results, then the report ends the run", async () => {
    await inRollback(db, async (tx) => {
      const vm = fakeVmClient((cmd) => ({ stdout: `ran: ${cmd}` }));
      const { deps, runId, requests } = await setup(
        tx,
        [
          toolCallReply("bash", { command: "ls ~/notes" }),
          toolCallReply("bash", { command: "cat ~/notes/lease.md" }),
          textReply("The lease renews on Jan 1 at $2,400/month."),
        ],
        vm.client,
      );
      expect(await drive(deps, runId)).toEqual([
        "continued",
        "continued",
        "finished",
      ]);
      const messages = await messagesOf(tx, runId);
      expect(roles(messages)).toEqual([
        "user",
        "assistant",
        "tool",
        "assistant",
        "tool",
        "assistant",
      ]);
      expect(JSON.stringify(messages[2])).toContain("ran: ls ~/notes");
      expect(vm.commands).toEqual(["ls ~/notes", "cat ~/notes/lease.md"]);
      expect(await runOf(tx, runId)).toMatchObject({
        status: "completed",
        stepCount: 3,
        result: "The lease renews on Jan 1 at $2,400/month.",
      });
      expect(requests).toHaveLength(3);
      // Opus at high effort, with the background prompt.
      expect(requests[0]?.model).toBe("anthropic/claude-opus-5.5");
      expect(requests[0]?.reasoning).toEqual({ effort: "high" });
      const calls = await tx
        .select()
        .from(modelCalls)
        .where(eq(modelCalls.runId, runId));
      expect(calls.map((c) => c.step).sort()).toEqual([0, 1, 2]);
    });
  });

  test("a worker dying mid-step resumes from the checkpoint without repeating finished work", async () => {
    await inRollback(db, async (tx) => {
      const controller = new AbortController();
      const commands: string[] = [];
      const vm: VmClient = {
        ...fakeVmClient().client,
        exec: (_userId, request) => {
          commands.push(request.cmd);
          if (request.cmd.includes("send")) {
            // The worker dies while this runs.
            controller.abort(new Error("worker stopped"));
            return Promise.reject(new Error("connection lost"));
          }
          return Promise.resolve({
            stdout: "ok",
            stderr: "",
            exitCode: 0,
            timedOut: false,
            truncated: false,
          });
        },
      };
      const { deps, runId, requests } = await setup(
        tx,
        [
          toolCallReply("bash", { command: "winston mail list" }),
          toolCallReply("bash", { command: "winston mail send --to a@b.c" }),
          textReply("Checked; the send may not have gone out."),
        ],
        vm,
      );
      expect(await runBackgroundStep(deps, runId)).toBe("continued");
      expect(
        await failure(runBackgroundStep(deps, runId, controller.signal)),
      ).toBe("worker stopped");
      // The model's request was kept, but not its result.
      expect(roles(await messagesOf(tx, runId)).at(-1)).toBe("assistant");

      // Another worker takes the job over.
      expect(await drive(deps, runId)).toEqual(["finished"]);
      const messages = await messagesOf(tx, runId);
      expect(JSON.stringify(messages.at(-2))).toContain(interruptedNote);
      // Neither command ran twice, and no model call was repeated.
      expect(commands).toEqual([
        "winston mail list",
        "winston mail send --to a@b.c",
      ]);
      expect(requests).toHaveLength(3);
      expect(await runOf(tx, runId)).toMatchObject({
        status: "completed",
        stepCount: 3,
      });
    });
  });

  test("at the step cap, the last call can't use tools and writes where it got to", async () => {
    await inRollback(db, async (tx) => {
      const { deps, runId, requests } = await setup(tx, [
        textReply("Got as far as the checkout page; the card was declined."),
      ]);
      await tx
        .update(runs)
        .set({ stepCount: maxStepsPerRun - 1 })
        .where(eq(runs.id, runId));
      expect(await drive(deps, runId)).toEqual(["finished"]);
      expect(requests[0]?.tool_choice).toBe("none");
      const messages = await messagesOf(tx, runId);
      expect(messages.at(-2)).toEqual({ role: "user", content: capNote });
      expect(await runOf(tx, runId)).toMatchObject({
        status: "capped",
        stepCount: maxStepsPerRun,
        result: "Got as far as the checkout page; the card was declined.",
      });
    });
  });

  test("transient model errors are retried in the step; persistent ones leave the checkpoint for the job's retry", async () => {
    await inRollback(db, async (tx) => {
      const { deps, runId, requests } = await setup(tx, [
        httpError(503),
        textReply("Done."),
      ]);
      expect(await drive(deps, runId)).toEqual(["finished"]);
      expect(requests).toHaveLength(2);
    });
    await inRollback(db, async (tx) => {
      const { deps, runId, requests } = await setup(tx, [httpError(503)]);
      expect(await failure(runBackgroundStep(deps, runId))).toContain("");
      // Three attempts, nothing stored, the run still going for the job's retry.
      expect(requests).toHaveLength(3);
      expect(roles(await messagesOf(tx, runId))).toEqual(["user"]);
      expect((await runOf(tx, runId))?.status).toBe("running");
    });
  });

  test("a cancelled run takes no step; a refusal fails the run; an empty ending is nudged once", async () => {
    await inRollback(db, async (tx) => {
      const { deps, runId, requests } = await setup(tx, [textReply("x")]);
      await tx
        .update(runs)
        .set({ status: "cancelled" })
        .where(eq(runs.id, runId));
      expect(await runBackgroundStep(deps, runId)).toBe("skipped");
      expect(requests).toHaveLength(0);
    });
    await inRollback(db, async (tx) => {
      const { deps, runId } = await setup(tx, [refusal()]);
      expect(await drive(deps, runId)).toEqual(["finished"]);
      expect(await runOf(tx, runId)).toMatchObject({
        status: "failed",
        result: "The model refused this task.",
      });
    });
    await inRollback(db, async (tx) => {
      const { deps, runId } = await setup(tx, [
        textReply(""),
        textReply("Here's the report."),
      ]);
      expect(await drive(deps, runId)).toEqual(["continued", "finished"]);
      expect((await runOf(tx, runId))?.result).toBe("Here's the report.");
    });
  });

  test("a finished run reports to the front of house: one item, one turn, and close finishes share the turn", async () => {
    await inRollback(db, async (tx) => {
      const { deps, runId, userId } = await setup(tx, [
        textReply("Northside is cheapest at $2,350/month."),
      ]);
      await drive(deps, runId);
      const second = await startBackgroundRun(tx, {
        userId,
        brief: "Check the gym's holiday hours.",
      });
      await tx
        .update(runs)
        .set({ status: "running" })
        .where(eq(runs.id, second));
      await finishTask(tx, second, "cap", "Found Monday's hours only.");
      const items = await tx
        .select()
        .from(inboundItems)
        .where(eq(inboundItems.userId, userId));
      expect(items.map((item) => [item.type, item.payload])).toEqual([
        [
          "task.completed",
          {
            taskId: runId,
            brief: "Find the lease and summarize the renewal terms.",
            report: "Northside is cheapest at $2,350/month.",
          },
        ],
        [
          "task.completed",
          {
            taskId: second,
            brief: "Check the gym's holiday hours.",
            report: "Found Monday's hours only.",
            capped: true,
          },
        ],
      ]);
      const turns = await tx
        .select()
        .from(jobs)
        .where(and(eq(jobs.type, "front_turn"), eq(jobs.userId, userId)));
      expect(turns).toHaveLength(1);
    });
  });

  test("a failure reports task.failed; a run cancelled meanwhile reports nothing", async () => {
    await inRollback(db, async (tx) => {
      const { deps, runId, userId } = await setup(tx, [refusal()]);
      await drive(deps, runId);
      const cancelled = await startBackgroundRun(tx, {
        userId,
        brief: "x".repeat(300),
      });
      await tx
        .update(runs)
        .set({ status: "cancelled" })
        .where(eq(runs.id, cancelled));
      expect(
        await finishTask(tx, cancelled, "complete", "late"),
      ).toBeUndefined();
      const items = await tx
        .select()
        .from(inboundItems)
        .where(eq(inboundItems.userId, userId));
      expect(items.map((item) => item.type)).toEqual(["task.failed"]);
      expect(items[0]?.payload).toMatchObject({
        report: "The model refused this task.",
      });
    });
  });

  test("a long brief is cut in the report", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const runId = await startBackgroundRun(tx, {
        userId: user.id,
        brief: "b".repeat(500),
      });
      await tx
        .update(runs)
        .set({ status: "running" })
        .where(eq(runs.id, runId));
      await finishTask(tx, runId, "complete", "done");
      const [item] = await tx
        .select({ payload: inboundItems.payload })
        .from(inboundItems)
        .where(eq(inboundItems.userId, user.id));
      expect((item?.payload as { brief: string }).brief).toBe(
        `${"b".repeat(200)}…`,
      );
    });
  });

  test("a cancelled task stops at the next step boundary: no more tools, a last report, then cancelled", async () => {
    await inRollback(db, async (tx) => {
      const vm = fakeVmClient();
      const { deps, runId, userId, requests } = await setup(
        tx,
        [
          toolCallReply("bash", { command: "winston mail list" }),
          textReply("I'd listed Nik's mail; nothing else was started."),
        ],
        vm.client,
      );
      expect(await runBackgroundStep(deps, runId)).toBe("continued");
      expect(await cancelTask(tx, runId)).toBe("cancelling");
      expect(await runBackgroundStep(deps, runId)).toBe("finished");
      expect(requests[1]?.tool_choice).toBe("none");
      const messages = await messagesOf(tx, runId);
      expect(messages.at(-2)).toEqual({ role: "user", content: cancelNote });
      expect(vm.commands).toEqual(["winston mail list"]);
      expect(await runOf(tx, runId)).toMatchObject({
        status: "cancelled",
        result: "I'd listed Nik's mail; nothing else was started.",
      });
      const [item] = await tx
        .select({ type: inboundItems.type, payload: inboundItems.payload })
        .from(inboundItems)
        .where(eq(inboundItems.userId, userId));
      expect(item).toMatchObject({
        type: "task.completed",
        payload: { cancelled: true },
      });
    });
  });

  test("cancelled while the model thinks: the tools it asked for don't start", async () => {
    await inRollback(db, async (tx) => {
      const vm = fakeVmClient();
      const user = await insertUser(tx);
      let runId = "";
      const fake = fakeGateway({
        replies: [
          toolCallReply("bash", { command: "winston mail send --to a@b.c" }),
          textReply("Stopped before sending anything."),
        ],
        onRequest: async (index) => {
          if (index === 0) await cancelTask(tx, runId);
        },
      });
      runId = await startBackgroundRun(tx, {
        userId: user.id,
        brief: "Send it.",
      });
      const deps: BackgroundDeps = {
        db: tx,
        logger,
        gateway: fake.gateway,
        vm: vm.client,
        runTokenSecret: testRunTokenSecret,
        webPublicUrl: "https://runwinston.com",
        blobs,
        retryDelayMs: 0,
      };
      expect(await drive(deps, runId)).toEqual(["continued", "finished"]);
      expect(vm.commands).toEqual([]);
      expect(JSON.stringify(await messagesOf(tx, runId))).toContain(
        cancelledToolNote,
      );
      expect((await runOf(tx, runId))?.status).toBe("cancelled");
    });
  });

  test("a handoff with a browser window holds it for the user and puts a live-view link in task.needs_user", async () => {
    await inRollback(db, async (tx) => {
      const held: string[] = [];
      const vm: VmClient = {
        ...fakeVmClient().client,
        holdBrowser: (_userId, owner) => {
          held.push(owner);
          return Promise.resolve({
            windowId: "win_1",
            targetId: "T1",
            url: "https://opentable.com",
          });
        },
      };
      const { deps, runId, userId } = await setup(
        tx,
        [
          {
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: "",
                  tool_calls: [
                    {
                      id: "call_handoff",
                      type: "function",
                      function: {
                        name: "browser_handoff",
                        arguments: JSON.stringify({
                          reason: "Sign in to OpenTable.",
                        }),
                      },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          },
        ],
        vm,
      );
      expect(await drive(deps, runId)).toEqual(["parked"]);
      // A background run's windows are named by its id on the VM.
      expect(held).toEqual([runId]);
      const [item] = await tx
        .select({ payload: inboundItems.payload })
        .from(inboundItems)
        .where(eq(inboundItems.userId, userId));
      expect((item?.payload as { link?: string }).link).toStartWith(
        "https://runwinston.com/t/",
      );
    });
  });

  test("a handoff parks the run with its reason and tells the front of house; resume answers it and carries on", async () => {
    await inRollback(db, async (tx) => {
      const vm = fakeVmClient();
      const { deps, runId, userId, requests } = await setup(
        tx,
        [
          {
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: "",
                  tool_calls: [
                    {
                      id: "call_bash",
                      type: "function",
                      function: {
                        name: "bash",
                        arguments: JSON.stringify({ command: "ls" }),
                      },
                    },
                    {
                      id: "call_handoff",
                      type: "function",
                      function: {
                        name: "browser_handoff",
                        arguments: JSON.stringify({
                          reason: "Sign in to OpenTable.",
                        }),
                      },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          },
          textReply("Booked: Friday 7pm, confirmation 4471."),
        ],
        vm.client,
      );
      expect(await drive(deps, runId)).toEqual(["parked"]);
      expect(await runOf(tx, runId)).toMatchObject({
        status: "parked",
        waitingFor: "Sign in to OpenTable.",
      });
      // Nothing ran beside the handoff, and no step is queued.
      expect(vm.commands).toEqual([]);
      const queued = await tx
        .select()
        .from(jobs)
        .where(
          and(
            eq(jobs.dedupeKey, runStepJob.dedupeKey(runId)),
            eq(jobs.status, "queued"),
          ),
        );
      // The first step's job was never leased in this test, so only it remains.
      expect(queued).toHaveLength(1);
      const [item] = await tx
        .select({ type: inboundItems.type, payload: inboundItems.payload })
        .from(inboundItems)
        .where(eq(inboundItems.userId, userId));
      expect(item).toEqual({
        type: "task.needs_user",
        payload: {
          taskId: runId,
          brief: "Find the lease and summarize the renewal terms.",
          reason: "Sign in to OpenTable.",
        },
      });

      expect(await resumeTask(tx, runId, "user says done")).toBe(true);
      const tool = (await messagesOf(tx, runId)).at(-1);
      expect(JSON.stringify(tool)).toContain(
        "The user is done. The front of house says: user says done",
      );
      expect(JSON.stringify(tool)).toContain(notRunBesideHandoff);
      expect(await drive(deps, runId)).toEqual(["finished"]);
      expect(requests).toHaveLength(2);
      expect(await runOf(tx, runId)).toMatchObject({
        status: "completed",
        waitingFor: null,
        result: "Booked: Friday 7pm, confirmation 4471.",
      });
    });
  });

  test("past the threshold, the run compacts once and carries on from the summary, also after resuming", async () => {
    await inRollback(db, async (tx) => {
      const big = {
        usage: { ...fakeCompletion.usage, prompt_tokens: 1_500 },
      };
      const { deps, runId, requests } = await setup(tx, [
        { ...toolCallReply("bash", { command: "ls" }), ...big },
        textReply(
          "## Goal and brief\nFind the lease.\n## Key facts\nlease.pdf",
        ),
        toolCallReply("bash", { command: "cat lease.md" }),
        textReply("Renews Jan 1."),
      ]);
      const compacting = { ...deps, compactAtTokens: 1_300 };
      expect(await drive(compacting, runId)).toEqual([
        "continued",
        "continued",
        "finished",
      ]);
      // One compaction call: the summarizer's prompt, no tools, the summary asked for last.
      expect(requests).toHaveLength(4);
      const compaction = requests[1] as {
        messages: { role: string; content: unknown }[];
        tool_choice?: string;
      };
      expect(JSON.stringify(compaction.messages[0])).toContain(
        "summarizing a background task",
      );
      expect(compaction.tool_choice).toBe("none");
      expect(JSON.stringify(compaction.messages.at(-1))).toContain(compactNow);
      const rows = await tx
        .select({ kind: runMessages.kind })
        .from(runMessages)
        .where(eq(runMessages.runId, runId));
      expect(rows.filter((r) => r.kind === "compaction")).toHaveLength(1);
      // The next calls see the brief and summary as one message, then the kept steps.
      for (const index of [2, 3]) {
        const sent = requests[index] as {
          messages: { role: string; content: unknown }[];
        };
        expect(sent.messages[1]?.role).toBe("user");
        const first = JSON.stringify(sent.messages[1]);
        expect(first).toContain("Find the lease and summarize");
        expect(first).toContain("summary_of_earlier_work");
        expect(sent.messages[2]?.role).toBe("assistant");
      }
      const calls = await tx
        .select({ promptHash: modelCalls.promptHash })
        .from(modelCalls)
        .where(eq(modelCalls.runId, runId));
      expect(new Set(calls.map((c) => c.promptHash)).size).toBe(2);
    });
  });

  test("the context after a compaction keeps the last five steps whole, starting at an assistant message", () => {
    let id = 0;
    const entry = (
      message: ModelMessage,
      kind: "message" | "compaction" = "message",
    ) => ({ id: (id += 1), kind, message });
    const step = (i: number) => [
      entry({
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: `c${String(i)}`,
            toolName: "bash",
            input: {},
          },
        ],
      }),
      entry({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: `c${String(i)}`,
            toolName: "bash",
            output: { type: "text", value: String(i) },
          },
        ],
      }),
    ];
    const log = [
      entry({ role: "user", content: "<task>brief</task>" }),
      ...Array.from({ length: 8 }, (_, i) => step(i)).flat(),
      entry({ role: "user", content: "SUMMARY" }, "compaction"),
      ...step(8),
    ];
    const context = contextOf(log);
    expect(context[0]).toEqual({
      role: "user",
      content:
        "<task>brief</task>\n\n<summary_of_earlier_work>\nSUMMARY\n</summary_of_earlier_work>\nThe steps after this summary are shown as they happened.",
    });
    // Steps 3–7 kept, then step 8 from after the compaction.
    expect(context).toHaveLength(1 + 5 * 2 + 2);
    expect(JSON.stringify(context[1])).toContain('"c3"');
    context.slice(1).forEach((message, i) => {
      expect(message.role).toBe(i % 2 === 0 ? "assistant" : "tool");
    });
    expect(contextOf(log.slice(0, 5))).toHaveLength(5);
  });

  test("a raised effort applies from the run's next model call", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const fake = fakeGateway({
        replies: [toolCallReply("bash", { command: "ls" }), textReply("Done.")],
      });
      const runId = await startBackgroundRun(tx, {
        userId: user.id,
        brief: "Check the inbox.",
        effort: "low",
      });
      const deps: BackgroundDeps = {
        db: tx,
        logger,
        gateway: fake.gateway,
        vm: fakeVmClient().client,
        runTokenSecret: testRunTokenSecret,
        webPublicUrl: "https://runwinston.com",
        blobs,
        retryDelayMs: 0,
      };
      await runBackgroundStep(deps, runId);
      await tx.update(runs).set({ effort: "xhigh" }).where(eq(runs.id, runId));
      await runBackgroundStep(deps, runId);
      expect(fake.requests.map((r) => r.reasoning)).toEqual([
        { effort: "low" },
        { effort: "xhigh" },
      ]);
    });
  });

  test("a crash after a send but before the checkpoint: resume reuses the VM's result, so the mail goes out once", async () => {
    await inRollback(db, async (tx) => {
      const controller = new AbortController();
      // Stands in for Gmail behind `winston mail send`, and winstond's buffer.
      const gmail = { sent: 0 };
      const buffered = new Map<string, ExecResult>();
      const vm: VmClient = {
        ...fakeVmClient().client,
        exec: (_userId, request) => {
          const cached = request.id ? buffered.get(request.id) : undefined;
          if (cached) return Promise.resolve(cached);
          gmail.sent += 1;
          const result: ExecResult = {
            stdout: "Sent msg_01sent in thr_01dana from me@example.com.\n",
            stderr: "",
            exitCode: 0,
            timedOut: false,
            truncated: false,
          };
          if (request.id) buffered.set(request.id, result);
          // The worker dies after the command ran, before it hears back.
          controller.abort(new Error("worker stopped"));
          return Promise.reject(new Error("connection lost"));
        },
        fetchExec: (_userId, execId) => Promise.resolve(buffered.get(execId)),
      };
      const { deps, runId } = await setup(
        tx,
        [
          toolCallReply("bash", { command: "winston mail send --to dana" }),
          textReply("Sent the reply to Dana (msg_01sent)."),
        ],
        vm,
      );
      expect(
        await failure(runBackgroundStep(deps, runId, controller.signal)),
      ).toBe("worker stopped");
      expect(await drive(deps, runId)).toEqual(["finished"]);
      expect(gmail.sent).toBe(1);
      const messages = await messagesOf(tx, runId);
      expect(JSON.stringify(messages.at(-2))).toContain("Sent msg_01sent");
      expect(JSON.stringify(messages)).not.toContain(interruptedNote);
    });
  });
});
