import { streamText, type LanguageModel, type ModelMessage } from "ai";

// A validation fixture, not the durable production conversation coordinator.
export class ConversationRevision {
  private revision = 0;
  private controller = new AbortController();

  advance() {
    this.controller.abort();
    this.controller = new AbortController();
    this.revision += 1;

    const revision = this.revision;
    const signal = this.controller.signal;

    return {
      signal,
      publish: (text: string, send: (text: string) => void) => {
        if (signal.aborted || revision !== this.revision) {
          return false;
        }

        send(text);
        return true;
      },
    };
  }
}

export async function collectReply(
  model: LanguageModel,
  messages: ModelMessage[],
  signal: AbortSignal,
  onText?: () => void,
  instructions?: string,
) {
  const started = performance.now();
  let firstTextMs: number | undefined;
  let text = "";
  let completed = false;

  const result = streamText({
    model,
    messages,
    ...(instructions === undefined ? {} : { instructions }),
    abortSignal: signal,
    maxRetries: 0,
    maxOutputTokens: 512,
    onError: () => {
      // Consume errors below; never log provider objects containing request data.
    },
  });

  for await (const part of result.stream) {
    if (part.type === "error") {
      throw part.error;
    }

    if (part.type === "text-delta") {
      firstTextMs ??= Math.round(performance.now() - started);
      text += part.text;
      onText?.();
    }

    if (part.type === "finish") {
      completed = part.finishReason === "stop";
    }
  }

  signal.throwIfAborted();

  if (!completed || text.trim().length === 0) {
    throw new Error("The model did not complete a text response.");
  }

  return { text, firstTextMs, totalMs: Math.round(performance.now() - started) };
}
