import { modelMessageSchema, type ModelMessage } from "ai";

export type ConversationExchange = { id: string; messages: ModelMessage[] };
export type WindowResult =
  | {
      kind: "ready";
      revision: number;
      messages: ModelMessage[];
      omittedExchanges: number;
      estimatedInputTokens: number;
    }
  | {
      kind: "requires-reference";
      revision: number;
      exchangeId: string;
      reason: "capacity" | "message-count";
    };

// A deliberately conservative text bound: one token per UTF-8 byte plus message framing.
// No tokenizer service, provider call, summarization, or durable-history mutation is involved.
export function textTokenBound(text: string) {
  return new TextEncoder().encode(text).length;
}

function validateExchange(exchange: ConversationExchange) {
  if (!exchange.id || !exchange.messages.length) throw new Error("Conversation exchange is empty.");
  const pending = new Map<string, string>();
  const seen = new Set<string>();
  for (const input of exchange.messages) {
    const message = modelMessageSchema.parse(input);
    if (message.role === "system")
      throw new Error("Trusted instructions belong outside conversation history.");
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "image" || part.type === "file")
        throw new Error("Conversation media must use verified text references.");
      if (part.type === "tool-call") {
        if (seen.has(part.toolCallId))
          throw new Error("Duplicate tool call in conversation exchange.");
        seen.add(part.toolCallId);
        pending.set(part.toolCallId, part.toolName);
      }
      if (part.type === "tool-result") {
        if (pending.get(part.toolCallId) !== part.toolName)
          throw new Error("Orphan tool result in conversation exchange.");
        pending.delete(part.toolCallId);
        if (part.output.type === "content" && part.output.value.some((item) => !("text" in item)))
          throw new Error("Conversation media must use verified text references.");
      }
    }
  }
  if (pending.size) throw new Error("Conversation exchange has unresolved tool calls.");
}

export function buildModelWindow(input: {
  revision: number;
  exchanges: ConversationExchange[];
  maxMessages: number;
  contextTokens: number;
  outputTokens: number;
  // Exact serialized instructions, tool declarations and authoritative context used by the caller.
  fixedContext: string;
  framingTokens?: number;
}): WindowResult {
  const framingTokens = input.framingTokens ?? 16_384;
  for (const value of [
    input.revision,
    input.maxMessages,
    input.contextTokens,
    input.outputTokens,
    framingTokens,
  ]) {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error("Invalid model window configuration.");
  }
  if (!input.maxMessages || !input.contextTokens || !input.exchanges.length)
    throw new Error("Model window needs a message and positive capacity.");
  const fixedTokens = textTokenBound(input.fixedContext) + framingTokens;
  const available = input.contextTokens - input.outputTokens - fixedTokens;
  const selected: ConversationExchange[] = [];
  let messageCount = 0;
  let tokens = 0;

  for (let index = input.exchanges.length - 1; index >= 0; index -= 1) {
    const exchange = input.exchanges[index];
    if (!exchange) throw new Error("Conversation exchange is unavailable.");
    validateExchange(exchange);
    const count = exchange.messages.length;
    const size = textTokenBound(JSON.stringify(exchange.messages)) + count * 64;
    const overCount = messageCount + count > input.maxMessages;
    const overCapacity = tokens + size > available;
    if (overCount || overCapacity) {
      if (!selected.length)
        return {
          kind: "requires-reference",
          revision: input.revision,
          exchangeId: exchange.id,
          reason: overCapacity ? "capacity" : "message-count",
        };
      break;
    }
    selected.unshift(exchange);
    messageCount += count;
    tokens += size;
  }

  return {
    kind: "ready",
    revision: input.revision,
    messages: selected.flatMap((exchange) => exchange.messages),
    omittedExchanges: input.exchanges.length - selected.length,
    estimatedInputTokens: fixedTokens + tokens,
  };
}
