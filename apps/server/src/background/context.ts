import type { TaskStep } from "@winston/contracts/task-steps";
import type { ConversationExchange, ModelMessage } from "@winston/adapters/models";

export function checkpointContext(steps: TaskStep[]) {
  const exchanges: ConversationExchange[] = [];
  for (const step of steps) {
    const payload = step.request.payload;
    if (payload.kind !== "model") continue;
    const results = steps.flatMap((entry) => {
      const value = entry.request.payload;
      return value.kind === "tool" && value.modelStepId === step.id ? [value] : [];
    });
    const pending = payload.calls.find(
      (call) => !results.some((result) => result.callId === call.id),
    );
    if (pending) return { exchanges, pending: { step, call: pending } };
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          ...(payload.text ? [{ type: "text" as const, text: payload.text }] : []),
          ...payload.calls.map((call) => ({
            type: "tool-call" as const,
            toolCallId: call.id,
            toolName: call.name,
            input: call.input,
          })),
        ],
      },
    ];
    if (payload.calls.length)
      messages.push({
        role: "tool",
        content: payload.calls.map((call) => {
          const result = results.find((entry) => entry.callId === call.id);
          if (!result) throw new Error("Missing saved tool result.");
          return {
            type: "tool-result",
            toolCallId: call.id,
            toolName: call.name,
            output: { type: "json", value: result.result },
          };
        }),
      });
    exchanges.push({ id: step.id, messages });
  }
  return { exchanges, pending: undefined };
}

export function taskContext(value: unknown) {
  const text = JSON.stringify(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return `<system_event kind="task_context">${text}</system_event>`;
}
