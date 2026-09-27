import { promptVersion } from "@winston/prompts";
import {
  createModelGateway,
  type ModelCall,
  type ModelRun,
} from "./gateway.ts";

/** An OpenRouter chat completion, as the fake transport returns it by default. */
export const fakeCompletion = {
  id: "gen-1",
  model: "anthropic/claude-sonnet-5",
  provider: "Anthropic",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "Done." },
      finish_reason: "stop",
    },
  ],
  usage: {
    prompt_tokens: 1200,
    completion_tokens: 40,
    total_tokens: 1240,
    prompt_tokens_details: { cached_tokens: 1000, cache_write_tokens: 150 },
    completion_tokens_details: { reasoning_tokens: 12 },
    cost: 0.00123,
  },
};

/**
 * A gateway over a fake OpenRouter: records request bodies, answers request
 * n with `fakeCompletion` merged with `replies[n]` (the last one repeats), and
 * collects model calls (or hands them to `sink`).
 */
export function fakeGateway(
  options: {
    replies?: Record<string, unknown>[];
    sink?: (call: ModelCall) => Promise<void>;
  } = {},
) {
  const replies = options.replies ?? [{}];
  const requests: Record<string, unknown>[] = [];
  const calls: ModelCall[] = [];
  const fetch = (async (_url: unknown, init?: RequestInit) => {
    // The provider always sends a JSON string body.
    requests.push(JSON.parse(init?.body as string) as Record<string, unknown>);
    await Promise.resolve();
    const reply = replies[Math.min(requests.length, replies.length) - 1];
    return Response.json({ ...fakeCompletion, ...reply });
  }) as typeof globalThis.fetch;
  const gateway = createModelGateway({
    apiKey: "test",
    fetch,
    sink:
      options.sink ??
      ((call) => {
        calls.push(call);
        return Promise.resolve();
      }),
  });
  return { gateway, requests, calls };
}

/**
 * A run for tests; ids default to placeholders. Each gets its own prompt
 * version: `ensurePromptVersion` remembers stored hashes per process, which a
 * rolled-back test would otherwise leave pointing at a row that's gone.
 */
export function testRun(overrides: Partial<ModelRun> = {}): ModelRun {
  return {
    runId: "run_test",
    userId: "usr_test",
    prompt: promptVersion("front-of-house", [
      { name: "test", description: crypto.randomUUID(), inputSchema: {} },
    ]),
    contextRange: () => ({ fromMessageId: 1, toMessageId: 1 }),
    ...overrides,
  };
}

let toolCallCount = 0;

/** A scripted reply in which the model calls one tool, optionally writing `text` alongside. */
export function toolCallReply(
  name: string,
  input: Record<string, unknown>,
  text = "",
) {
  toolCallCount += 1;
  return {
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text,
          tool_calls: [
            {
              id: `call_${String(toolCallCount)}`,
              type: "function",
              function: { name, arguments: JSON.stringify(input) },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  };
}

/** A scripted reply in which the model writes text and stops. */
export function textReply(text: string) {
  return {
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
  };
}
