import type { createDatabase } from "@winston/adapters/database";
import type { createJobRuntime } from "@winston/adapters/jobs";
import type { ModelRequest, ModelResult } from "@winston/adapters/models";
import { createBackgroundStep } from "./step";

export async function startBackgroundRuntime(options: {
  database: ReturnType<typeof createDatabase>;
  jobs: Pick<ReturnType<typeof createJobRuntime>, "work" | "enqueue" | "inspect">;
  botId: number;
  generate: (request: ModelRequest) => Promise<ModelResult>;
  notice: (code: string) => void;
}) {
  const { database, jobs } = options;
  const shutdown = new AbortController();
  const stopping = () => shutdown.signal.aborted;
  const step = createBackgroundStep({ database, generate: options.generate });
  await jobs.work("background", (reference, signal) =>
    step(reference, AbortSignal.any([signal, shutdown.signal])),
  );
  let cursor: string | undefined;
  let active: Promise<void> | undefined;
  async function pump() {
    const owners = await database.telegramOwners(options.botId, cursor);
    cursor = owners.length === 100 ? owners.at(-1) : undefined;
    for (const ownerId of owners) {
      if (stopping()) return;
      const ready = await database.transaction(ownerId, async ({ tasks, actions }) => {
        await tasks.wakeDue();
        for (const task of await tasks.listActive()) {
          if (task.state !== "waiting" || task.blocker?.kind !== "approval") continue;
          const action = await actions.find(task.blocker.referenceId);
          if (
            action?.request.task.id === task.id &&
            ["approved", "denied", "invalidated", "succeeded", "failed"].includes(action.state)
          )
            await tasks.resume(task.id, task.revision, task.blocker.referenceId);
        }
        return tasks.runnable();
      });
      for (const task of ready) {
        if (stopping()) return;
        const reference = { ownerId, referenceId: task.id, revision: task.revision };
        const job = await jobs.inspect("background", reference);
        if (job?.terminalFailure) {
          await database.transaction(ownerId, async ({ tasks }) => {
            const current = await tasks.find(task.id);
            if (!current || current.revision !== task.revision) return;
            const failed = await tasks.claim(current.id, current.revision);
            await tasks.finishStep(failed.id, failed.revision, failed.generation, {
              state: "failed",
              result: "The background worker could not start after retrying.",
            });
          });
        } else {
          await jobs.enqueue("background", reference);
        }
      }
    }
  }
  const tick = () => {
    if (active || shutdown.signal.aborted) return;
    active = pump()
      .catch(() => {
        options.notice("background-pump-failed");
      })
      .finally(() => {
        active = undefined;
      });
  };
  const timer = setInterval(tick, 500);
  tick();
  return {
    async stop() {
      clearInterval(timer);
      shutdown.abort();
      await active;
    },
  };
}
