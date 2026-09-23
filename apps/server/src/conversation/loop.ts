import type { createDatabase, OwnerTransaction } from "@winston/adapters/database";
import {
  buildModelWindow,
  modelRoles,
  type ModelMessage,
  type ModelRequest,
  type ModelResult,
} from "@winston/adapters/models";
import { turnRoundSchema } from "@winston/contracts/turns";
import { serializeMemoryContext } from "@winston/contracts/memory";
import { serializeMessageBurst } from "@winston/contracts/bursts";
import { conversationTools, executeConversationTool, toolContext } from "./tools";

type Database = ReturnType<typeof createDatabase>;
class Superseded extends Error {}

function xml(text: string) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function createConversationLoop(options: {
  database: Database;
  botId: number;
  generate: (request: ModelRequest) => Promise<ModelResult>;
}) {
  return async (ownerId: string, revision: number, signal: AbortSignal) => {
    const { database } = options;
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(60_000)]);
    async function current(scope: OwnerTransaction) {
      combined.throwIfAborted();
      const state = await scope.conversations.status();
      if (
        state.revision !== revision ||
        state.pending ||
        state.responseRevision >= state.inputRevision
      )
        throw new Superseded();
    }
    let checking = false;
    const monitor = { superseded: false };
    const timer = setInterval(() => {
      if (checking || combined.aborted) return;
      checking = true;
      database
        .transaction(ownerId, current)
        .catch((error: unknown) => {
          monitor.superseded = error instanceof Superseded;
          controller.abort();
        })
        .finally(() => {
          checking = false;
        });
    }, 150);

    try {
      const snapshot = await database.transaction(ownerId, async (scope) => {
        await current(scope);
        const state = await scope.conversations.snapshot(modelRoles.conversation.windowMessages);
        const anchor = state.messages.at(-1);
        if (!anchor) throw new Superseded();
        await scope.turns.begin(revision, anchor.envelope.messageId);
        const history = await scope.turns.history(
          state.messages.map((message) => message.envelope.messageId),
        );
        const query = anchor.envelope.input.text.trim().slice(0, 300);
        const memories = query ? await scope.memory.search(query) : [];
        return { ...state, history, memories };
      });
      const exchanges = snapshot.messages.map((message) => ({
        id: message.envelope.messageId,
        messages: [
          { role: "user", content: message.content },
          ...snapshot.history
            .filter((turn) => turn.anchorId === message.envelope.messageId)
            .flatMap((turn): ModelMessage[] => [
              ...(turn.updates.length
                ? [
                    {
                      role: "user" as const,
                      content: `<system_event kind="delivered_task_completions">${xml(JSON.stringify(turn.updates))}</system_event>`,
                    },
                  ]
                : []),
              ...turn.steps.flatMap(({ round, results }): ModelMessage[] => {
                if (!round.calls.length) return [];
                return [
                  {
                    role: "assistant",
                    content: round.calls.map((call) => ({
                      type: "tool-call",
                      toolCallId: call.id,
                      toolName: call.name,
                      input: call.input,
                    })),
                  },
                  {
                    role: "tool",
                    content: round.calls.map((call) => {
                      const value = results[call.id];
                      if (value === undefined)
                        throw new Error("Delivered turn has an incomplete tool exchange.");
                      return {
                        type: "tool-result",
                        toolCallId: call.id,
                        toolName: call.name,
                        output: { type: "json", value },
                      };
                    }),
                  },
                ];
              }),
              { role: "assistant", content: turn.parts.join("\n") },
            ]),
        ] as ModelMessage[],
      }));
      const last = exchanges.at(-1);
      if (!last) throw new Superseded();
      const taskContext = snapshot.activeTasks.map((task) => ({
        id: task.id,
        revision: task.revision,
        state: task.state,
        objectivePreview: task.objective.slice(0, 500),
        blocker: task.blocker,
      }));
      const burstIds = snapshot.messages
        .filter((message) => message.conversationRevision > snapshot.responseRevision)
        .map((message) => message.envelope.messageId);
      const burst = burstIds.length
        ? serializeMessageBurst({ revision, messageIds: burstIds })
        : "";
      const completions = snapshot.taskUpdates.length
        ? `<system_event kind="task_completions">${xml(JSON.stringify(snapshot.taskUpdates))}</system_event>`
        : "";
      const context = `<system_event kind="task_state">${xml(JSON.stringify(taskContext))}</system_event>\n<system_event kind="task_resources">${xml(JSON.stringify(snapshot.taskResources))}</system_event>\n${serializeMemoryContext(snapshot.memories)}\n${burst}\n${completions}`;
      const user = last.messages[0];
      if (user && typeof user.content === "string") user.content += `\n${context}`;
      const sourceMessageIds = snapshot.messages
        .slice(-100)
        .map((message) => message.envelope.messageId);
      const publish = async (text: string) =>
        database.transaction(ownerId, async (scope) => {
          await current(scope);
          if (!(await scope.conversations.markResponded(revision))) throw new Superseded();
          const id = await scope.telegramOutbound.enqueue(
            `conversation:${String(revision)}`,
            options.botId,
            text,
          );
          await scope.turns.finish(revision, id);
          await scope.taskUpdates.link(
            snapshot.taskUpdates.map((update) => update.id),
            id,
          );
        });

      for (let step = 0; step < 4; step += 1) {
        const window = buildModelWindow({
          revision,
          exchanges,
          maxMessages: modelRoles.conversation.windowMessages,
          contextTokens: modelRoles.conversation.contextTokens,
          outputTokens: modelRoles.conversation.maxOutputTokens,
          fixedContext: modelRoles.conversation.instructions + toolContext,
        });
        if (window.kind === "requires-reference") {
          await publish(
            "This request is too large for me to read in one turn. Please send a smaller excerpt or split it into parts.",
          );
          return;
        }
        let round = await database.transaction(ownerId, async (scope) => {
          await current(scope);
          return scope.turns.round(revision, step);
        });
        if (!round) {
          const result = await options.generate({
            role: "conversation",
            messages: window.messages,
            signal: combined,
            tools: conversationTools,
          });
          if (!result.ok) {
            combined.throwIfAborted();
            if (result.retryable) throw new Error("Conversation model temporarily unavailable.");
            await publish("I couldn’t finish that response. Please try again.");
            return;
          }
          round = await database.transaction(ownerId, async (scope) => {
            await current(scope);
            return scope.turns.saveRound(
              revision,
              step,
              turnRoundSchema.parse({ text: result.text, calls: result.toolCalls }),
            );
          });
        }
        if (!round.calls.length) {
          await publish(round.text);
          return;
        }
        last.messages.push({
          role: "assistant",
          content: round.calls.map((call) => ({
            type: "tool-call",
            toolCallId: call.id,
            toolName: call.name,
            input: call.input,
          })),
        });
        for (const [index, call] of round.calls.entries()) {
          const value = await database.transaction(ownerId, async (scope) => {
            await current(scope);
            const saved = await scope.turns.toolResult(revision, step, call.id);
            if (saved) return saved.value;
            const result = await executeConversationTool(
              scope,
              call,
              `turn:${String(revision)}:${String(step)}:${String(index)}`,
              sourceMessageIds,
            );
            await scope.turns.saveToolResult(revision, step, call.id, result);
            return result;
          });
          last.messages.push({
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: call.id,
                toolName: call.name,
                output: { type: "json", value },
              },
            ],
          });
        }
      }
      await publish(
        "I couldn’t finish that request in one turn. You can ask me for the current task status.",
      );
    } catch (error) {
      if (error instanceof Superseded || monitor.superseded) return;
      throw error;
    } finally {
      clearInterval(timer);
      controller.abort();
    }
  };
}
