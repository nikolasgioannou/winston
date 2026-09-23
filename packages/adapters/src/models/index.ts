import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import {
  APICallError,
  InvalidToolInputError,
  NoSuchToolError,
  streamText,
  type LanguageModel,
  type ModelMessage,
  type Tool,
} from "ai";
import { modelRoles, type ModelRole } from "./config";

export { modelRoles, type ModelRole } from "./config";
export { createVoiceTranscriber, TranscriptionError, transcriptionModel } from "./transcription";
export { transcribeNextVoice } from "./transcribe-next";
export {
  buildModelWindow,
  textTokenBound,
  type ConversationExchange,
  type WindowResult,
} from "./window";

export type ModelFailure =
  | "canceled"
  | "timeout"
  | "throttled"
  | "unavailable"
  | "credentials"
  | "invalid-output"
  | "incomplete"
  | "request-failed";

export type ModelAttempt = {
  role: ModelRole;
  model: string;
  promptVersion: string;
  elapsedMs: number;
  firstTextMs: number | null;
};

export type ModelResult =
  | {
      ok: true;
      text: string;
      toolCalls: { id: string; name: string; input: unknown }[];
      attempt: ModelAttempt;
    }
  | { ok: false; code: ModelFailure; retryable: boolean; attempt: ModelAttempt };

// No execute callback or provider-executed tools: the application owns authorization and dispatch.
export type ModelTools = Record<string, Pick<Tool, "description" | "inputSchema">>;
export type { ModelMessage } from "ai";
export type ModelRequest = {
  role: ModelRole;
  messages: ModelMessage[];
  signal: AbortSignal;
  tools?: ModelTools;
};

class InvalidOutput extends Error {}
class IncompleteOutput extends Error {}

function failure(error: unknown): ModelFailure {
  if (
    error instanceof InvalidOutput ||
    InvalidToolInputError.isInstance(error) ||
    NoSuchToolError.isInstance(error)
  )
    return "invalid-output";
  if (error instanceof IncompleteOutput) return "incomplete";
  if (APICallError.isInstance(error)) {
    if (error.statusCode === 429) return "throttled";
    if (error.statusCode === 401 || error.statusCode === 403) return "credentials";
    if (error.statusCode === undefined || error.statusCode >= 500 || error.statusCode === 408)
      return "unavailable";
  }

  return "request-failed";
}

export function createModelAdapter(options: {
  model: (role: ModelRole) => LanguageModel;
  // Injected for deterministic tests; deployment uses the versioned role defaults.
  timeoutMs?: number;
}) {
  return {
    async generate(request: ModelRequest): Promise<ModelResult> {
      const config = modelRoles[request.role];
      const started = performance.now();
      let firstTextMs: number | null = null;
      const timeout = new AbortController();
      const duration = options.timeoutMs ?? config.timeoutMs;
      if (!Number.isFinite(duration) || duration <= 0)
        throw new Error("Model timeout must be positive.");
      const timer = setTimeout(() => {
        timeout.abort();
      }, duration);
      const signal = AbortSignal.any([request.signal, timeout.signal]);
      const attempt = (): ModelAttempt => ({
        role: request.role,
        model: config.model,
        promptVersion: config.promptVersion,
        elapsedMs: Math.round(performance.now() - started),
        firstTextMs,
      });
      let onAbort: (() => void) | undefined;

      try {
        signal.throwIfAborted();
        // Copy only declaration fields even if a runtime caller supplied executable properties.
        const tools = Object.fromEntries(
          Object.entries(request.tools ?? {}).map(([name, definition]) => [
            name,
            {
              inputSchema: definition.inputSchema,
              ...(definition.description === undefined
                ? {}
                : { description: definition.description }),
            },
          ]),
        );
        const result = streamText({
          model: options.model(request.role),
          instructions: config.instructions,
          messages: request.messages,
          tools,
          abortSignal: signal,
          maxRetries: 0,
          maxOutputTokens: config.maxOutputTokens,
          onError: () => {
            /* Classified below without logging raw request/provider objects. */
          },
        });
        const collect = async () => {
          let text = "";
          let complete = false;
          const toolCalls: { id: string; name: string; input: unknown }[] = [];
          for await (const part of result.stream) {
            signal.throwIfAborted();
            if (part.type === "error") throw part.error;
            if (part.type === "text-delta") {
              firstTextMs ??= Math.round(performance.now() - started);
              text += part.text;
            }
            if (part.type === "tool-call") {
              if (
                part.invalid ||
                part.dynamic ||
                part.providerExecuted ||
                !Object.hasOwn(tools, part.toolName)
              )
                throw new InvalidOutput();
              toolCalls.push({ id: part.toolCallId, name: part.toolName, input: part.input });
            }
            if (part.type === "finish") {
              complete = part.finishReason === "stop" || part.finishReason === "tool-calls";
            }
          }
          signal.throwIfAborted();
          if (!complete || (!text.trim() && !toolCalls.length)) throw new IncompleteOutput();

          return { text, toolCalls };
        };
        const canceled = new Promise<never>((_resolve, reject) => {
          onAbort = () => {
            reject(new Error("Model attempt interrupted."));
          };
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        });
        const output = await Promise.race([collect(), canceled]);

        return { ok: true, ...output, attempt: attempt() };
      } catch (error) {
        const code = request.signal.aborted
          ? "canceled"
          : timeout.signal.aborted
            ? "timeout"
            : failure(error);

        return {
          ok: false,
          code,
          retryable: ["timeout", "throttled", "unavailable"].includes(code),
          attempt: attempt(),
        };
      } finally {
        clearTimeout(timer);
        if (onAbort) signal.removeEventListener("abort", onAbort);
        timeout.abort();
      }
    },
  };
}

export function createOpenRouterAdapter(apiKey: string) {
  if (!apiKey.trim()) throw new Error("An OpenRouter API key is required.");
  const provider = createOpenRouter({ apiKey, compatibility: "strict" });

  return createModelAdapter({
    model: (role) =>
      provider(modelRoles[role].model, { reasoning: { effort: modelRoles[role].reasoning } }),
  });
}
