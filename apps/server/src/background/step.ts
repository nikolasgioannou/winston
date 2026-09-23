import { setTimeout as sleep } from "node:timers/promises";
import type { createDatabase } from "@winston/adapters/database";
import {
  buildModelWindow,
  modelRoles,
  type ModelRequest,
  type ModelResult,
} from "@winston/adapters/models";
import { createWorkspaceSessions } from "@winston/adapters/workspace";
import type { JobReference } from "@winston/contracts/jobs";
import type { JsonValue } from "@winston/contracts/json";
import { taskStepPayloadSchema } from "@winston/contracts/task-steps";
import type { TaskOutcome } from "@winston/contracts/tasks";
import { workspaceCommandToolInputSchema } from "@winston/contracts/workspace-commands";
import { checkpointContext, taskContext } from "./context";
import { backgroundTools, backgroundToolContext, finishSchema } from "./tools";

export function createBackgroundStep(options: {
  database: ReturnType<typeof createDatabase>;
  generate: (request: ModelRequest) => Promise<ModelResult>;
  sessions?: ReturnType<typeof createWorkspaceSessions>;
}) {
  const { database } = options;
  const sessions = options.sessions ?? createWorkspaceSessions({ database });
  return async (reference: JobReference, signal: AbortSignal) => {
    const task = await database.transaction(reference.ownerId, async ({ tasks }) => {
      const current = await tasks.find(reference.referenceId);
      if (
        !current ||
        current.revision !== reference.revision ||
        !["queued", "running"].includes(current.state)
      )
        return null;
      const runnable = await tasks.runnable(1, current.id);
      if (!runnable.some((entry) => entry.id === current.id)) return null;
      return tasks.claim(current.id, current.revision);
    });
    if (!task) return;
    const worker = { id: task.id, revision: task.revision, generation: task.generation };
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    let heartbeat: Promise<void> | undefined;
    const timer = setInterval(() => {
      if (heartbeat || combined.aborted) return;
      heartbeat = database
        .transaction(reference.ownerId, ({ tasks }) =>
          tasks.heartbeat(worker.id, worker.revision, worker.generation),
        )
        .then((live) => {
          if (!live) controller.abort();
        })
        .catch(() => {
          controller.abort();
        })
        .finally(() => {
          heartbeat = undefined;
        });
    }, 10_000);
    const finish = (outcome: TaskOutcome) =>
      database.transaction(reference.ownerId, ({ tasks }) =>
        tasks.finishStep(worker.id, worker.revision, worker.generation, outcome),
      );
    try {
      combined.throwIfAborted();
      const snapshot = await database.transaction(
        reference.ownerId,
        async ({ tasks, taskSteps }) => ({
          context: await tasks.context(worker),
          history: await taskSteps.recent(worker, 250),
        }),
      );
      const history = checkpointContext(snapshot.history.steps);
      const sequence = snapshot.history.steps.at(-1)?.sequence ?? 0;
      if (history.pending) {
        const { step, call } = history.pending;
        let result: JsonValue = {
          error: "Invalid tool request.",
        };
        let actionId: string | null = null;
        const finishRequest = finishSchema.safeParse(call.input);
        if (
          call.name === "finish_task" &&
          finishRequest.success &&
          step.request.payload.kind === "model" &&
          step.request.payload.calls.length === 1
        ) {
          await database.transaction(reference.ownerId, async ({ taskSteps, tasks }) => {
            combined.throwIfAborted();
            await taskSteps.append(worker, {
              key: `tool:${step.id}:${String(sequence)}`,
              afterSequence: sequence,
              payload: {
                kind: "tool",
                modelStepId: step.id,
                callId: call.id,
                actionId: null,
                result: { accepted: true },
              },
            });
            await tasks.finishStep(
              worker.id,
              worker.revision,
              worker.generation,
              finishRequest.data,
            );
          });
          return;
        }
        const command = workspaceCommandToolInputSchema.safeParse(call.input);
        if (call.name === "workspace_command" && command.success) {
          const opened = await sessions.open(
            { ownerId: reference.ownerId, task: worker, modelStepId: step.id, callId: call.id },
            combined,
          );
          let state = opened.kind === "session" ? await opened.poll(combined) : opened;
          while (state.kind === "running" && opened.kind === "session") {
            await sleep(2000, undefined, { signal: combined });
            state = await opened.poll(combined);
          }
          combined.throwIfAborted();
          if (state.kind === "blocked") {
            if (state.reason === "stale") return;
            const kind =
              state.reason === "approval"
                ? "approval"
                : state.reason === "unavailable"
                  ? "workspace"
                  : "execution";
            await finish({
              state: "waiting",
              blocker: {
                kind,
                referenceId: kind === "workspace" ? command.data.workspaceId : state.actionId,
                detail:
                  kind === "approval"
                    ? "Waiting for approval."
                    : kind === "workspace"
                      ? "Winston's computer is unavailable."
                      : "The command outcome needs reconciliation; it will not be repeated automatically.",
              },
            });
            return;
          }
          if (state.kind !== "finished")
            throw new Error("Execution did not reach a durable state.");
          actionId = state.action.id;
          result = { actionId, state: state.action.state, outcome: state.action.outcome };
        }
        await database.transaction(reference.ownerId, async ({ taskSteps, tasks }) => {
          combined.throwIfAborted();
          await taskSteps.append(worker, {
            key: `tool:${step.id}:${String(sequence)}`,
            afterSequence: sequence,
            payload: taskStepPayloadSchema.parse({
              kind: "tool",
              modelStepId: step.id,
              callId: call.id,
              actionId,
              result,
            }),
          });
          await tasks.yield(worker);
        });
        return;
      }
      const context = taskContext({
        task: snapshot.context.task,
        resources: snapshot.context.resources,
        workspaces: snapshot.context.workspaces,
      });
      const config = modelRoles.worker;
      const exchanges = [
        ...snapshot.context.messages.map((message) => ({
          id: message.id,
          messages: [{ role: "user" as const, content: message.content }],
        })),
        ...history.exchanges,
      ];
      const appendContext = exchanges.length > 0;
      if (!appendContext)
        exchanges.push({ id: task.id, messages: [{ role: "user", content: context }] });
      const window = buildModelWindow({
        revision: worker.revision,
        exchanges,
        maxMessages: config.windowMessages - (appendContext ? 1 : 0),
        contextTokens: config.contextTokens,
        outputTokens: config.maxOutputTokens,
        fixedContext: config.instructions + backgroundToolContext + (appendContext ? context : ""),
      });
      if (window.kind !== "ready") {
        await finish({
          state: "failed",
          result:
            "This task's input is too large to read safely. Please provide a smaller excerpt.",
        });
        return;
      }
      const response = await options.generate({
        role: "worker",
        messages: [
          ...window.messages,
          ...(appendContext ? [{ role: "user" as const, content: context }] : []),
        ],
        tools: backgroundTools,
        signal: combined,
      });
      combined.throwIfAborted();
      if (!response.ok) {
        if (response.retryable) throw new Error("Background model temporarily unavailable.");
        await finish({
          state: "failed",
          result: "I couldn't produce a valid next step for this task.",
        });
        return;
      }
      const payload = taskStepPayloadSchema.safeParse({
        kind: "model",
        text: response.text,
        calls: response.toolCalls,
      });
      if (!payload.success || response.toolCalls.length === 0) {
        await finish({
          state: "failed",
          result: "The model returned an invalid or oversized step.",
        });
        return;
      }
      await database.transaction(reference.ownerId, async ({ taskSteps, tasks }) => {
        combined.throwIfAborted();
        await taskSteps.append(worker, {
          key: `model:${String(sequence)}`,
          afterSequence: sequence,
          payload: payload.data,
        });
        await tasks.yield(worker);
      });
    } finally {
      clearInterval(timer);
      await heartbeat;
    }
  };
}
