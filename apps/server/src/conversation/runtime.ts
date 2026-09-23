import { dispatchNext, type createDatabase } from "@winston/adapters/database";
import { createJobRuntime } from "@winston/adapters/jobs";
import { createOpenRouterAdapter } from "@winston/adapters/models";
import { createTelegramSender, deliverTelegramNext } from "@winston/adapters/telegram";
import { createConversationLoop } from "./loop";
import { startBackgroundRuntime } from "../background/runtime";

export async function startConversationRuntime(options: {
  database: ReturnType<typeof createDatabase>;
  directConnectionString: string;
  apiKey: string;
  botId: number;
  telegramToken: string;
  notice: (code: string) => void;
}) {
  const { database, botId } = options;
  const shutdown = new AbortController();
  const jobs = createJobRuntime({
    directConnectionString: options.directConnectionString,
    onNotice: options.notice,
  });
  const model = createOpenRouterAdapter(options.apiKey);
  const conversation = createConversationLoop({
    database,
    botId,
    generate: (request) => model.generate(request),
  });
  const send = createTelegramSender(options.telegramToken);
  const deliveries = new Map<string, Promise<void>>();
  await jobs.start();
  let background: Awaited<ReturnType<typeof startBackgroundRuntime>> | undefined;
  try {
    await jobs.work("conversation", async (reference, signal) => {
      await conversation(
        reference.ownerId,
        reference.revision,
        AbortSignal.any([signal, shutdown.signal]),
      );
    });
    background = await startBackgroundRuntime({
      database,
      jobs,
      botId,
      generate: (request) => model.generate(request),
      notice: options.notice,
    });
  } catch (error) {
    await jobs.stop();
    throw error;
  }
  let active: Promise<void> | undefined;
  let cursor: string | undefined;
  async function pump() {
    const owners = await database.telegramOwners(botId, cursor);
    cursor = owners.length === 100 ? owners.at(-1) : undefined;
    for (const ownerId of owners) {
      if (shutdown.signal.aborted) return;
      for (let count = 0; count < 100; count += 1) {
        const result = await dispatchNext(
          database,
          ownerId,
          "conversation-inbox",
          async (event) => {
            await database.transaction(ownerId, ({ conversations }) =>
              conversations.consumeTelegram(event.id),
            );
          },
          shutdown.signal,
        );
        if (result !== "delivered") break;
      }
      const state = await database.transaction(ownerId, ({ conversations }) =>
        conversations.status(),
      );
      if (state.ready && !state.pending && state.responseRevision < state.inputRevision) {
        const reference = { ownerId, referenceId: state.id, revision: state.revision };
        const job = await jobs.inspect("conversation", reference);
        if (job?.terminalFailure) {
          await database.transaction(ownerId, async (scope) => {
            if (!(await scope.conversations.markResponded(state.revision))) return;
            await scope.telegramOutbound.enqueue(
              `conversation-failed:${String(state.revision)}`,
              botId,
              "I couldn’t finish that response after retrying. Please try again.",
            );
          });
        } else {
          await jobs.enqueue("conversation", reference);
        }
      }
      if (!deliveries.has(ownerId) && deliveries.size < 4) {
        const delivery = deliverTelegramNext(database, ownerId, botId, send, shutdown.signal)
          .then((outcome) => {
            if (["uncertain", "rejected", "lease-lost"].includes(outcome))
              options.notice(`telegram-${outcome}`);
          })
          .catch(() => {
            options.notice("telegram-delivery-failed");
          })
          .finally(() => {
            deliveries.delete(ownerId);
          });
        deliveries.set(ownerId, delivery);
      }
    }
  }
  const tick = () => {
    if (active || shutdown.signal.aborted) return;
    active = pump()
      .catch(() => {
        options.notice("conversation-pump-failed");
      })
      .finally(() => {
        active = undefined;
      });
  };
  const timer = setInterval(tick, 250);
  tick();

  return {
    async stop() {
      clearInterval(timer);
      shutdown.abort();
      await active;
      await background.stop();
      await jobs.stop();
      await Promise.all(deliveries.values());
    },
  };
}
