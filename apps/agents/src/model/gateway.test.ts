import { describe, expect, test } from "bun:test";
import { generateText, type ModelMessage } from "ai";
import { cacheBreakpoint } from "./cache.ts";
import { createModelGateway } from "./gateway.ts";
import { recordStep } from "./record.ts";

/** A fake OpenRouter: records request bodies and answers with `reply`. */
function fakeOpenRouter(reply: Record<string, unknown> = {}) {
  const requests: Record<string, unknown>[] = [];
  const fetch = (async (_url: unknown, init?: RequestInit) => {
    // The provider always sends a JSON string body.
    requests.push(JSON.parse(init?.body as string) as Record<string, unknown>);
    await Promise.resolve();
    return Response.json({
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
      ...reply,
    });
  }) as typeof globalThis.fetch;
  return { requests, gateway: createModelGateway({ apiKey: "test", fetch }) };
}

describe("model gateway", () => {
  test("pins Anthropic with no fallbacks, sends the profile's effort, and asks for usage", async () => {
    const { requests, gateway } = fakeOpenRouter();
    await generateText({
      model: gateway.model("background"),
      prompt: "hi",
    });
    expect(requests[0]).toMatchObject({
      model: "anthropic/claude-opus-5.5",
      provider: { order: ["anthropic"], allow_fallbacks: false },
      reasoning: { effort: "high" },
      usage: { include: true },
    });
    await generateText({ model: gateway.model("front"), prompt: "hi" });
    expect(requests[1]).toMatchObject({
      model: "anthropic/claude-sonnet-5",
      reasoning: { effort: "low" },
    });
  });

  test("cache breakpoints reach the request", async () => {
    const { requests, gateway } = fakeOpenRouter();
    const messages: ModelMessage[] = [
      cacheBreakpoint({
        role: "user",
        content: [{ type: "text", text: "earlier" }],
      }),
      { role: "user", content: "now" },
    ];
    await generateText({
      model: gateway.model("front"),
      instructions: cacheBreakpoint({
        role: "system",
        content: "You are Winston.",
      }),
      messages,
    });
    const sent = JSON.stringify(requests[0]?.messages);
    expect(sent.match(/"cache_control":\{"type":"ephemeral"\}/g)).toHaveLength(
      2,
    );
  });

  test("keeps existing provider options when marking a breakpoint", () => {
    const marked = cacheBreakpoint<ModelMessage>({
      role: "user",
      content: "x",
      providerOptions: { openrouter: { other: 1 }, anthropic: { a: true } },
    });
    expect(marked.providerOptions).toEqual({
      openrouter: { other: 1, cacheControl: { type: "ephemeral" } },
      anthropic: { a: true },
    });
  });

  test("rejects sampling settings and forced tool choice before sending", async () => {
    const { requests, gateway } = fakeOpenRouter();
    const model = gateway.model("front");
    for (const settings of [{ temperature: 0.2 }, { topP: 0.9 }, { topK: 5 }]) {
      const error = await generateText({
        model,
        prompt: "hi",
        ...settings,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
    }
    const forced = await generateText({
      model,
      prompt: "hi",
      toolChoice: "required",
    }).catch((e: unknown) => e);
    expect(forced).toBeInstanceOf(Error);
    expect(requests).toEqual([]);
  });
});

describe("recordStep", () => {
  test("normalizes usage, cost, provider and latency", async () => {
    const { gateway } = fakeOpenRouter();
    const result = await generateText({
      model: gateway.model("front"),
      prompt: "hi",
    });
    const record = recordStep(result.steps[0] ?? result.finalStep);
    expect(record).toMatchObject({
      model: "anthropic/claude-sonnet-5",
      provider: "Anthropic",
      inputTokens: 1200,
      cachedTokens: 1000,
      cacheWriteTokens: 150,
      outputTokens: 40,
      reasoningTokens: 12,
      costUsd: 0.00123,
      stopReason: "stop",
    });
    expect(record.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test("reports a refusal as such", async () => {
    const { gateway } = fakeOpenRouter({
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "" },
          finish_reason: "refusal",
        },
      ],
    });
    const result = await generateText({
      model: gateway.model("front"),
      prompt: "hi",
    });
    expect(recordStep(result.finalStep).stopReason).toBe("refusal");
  });
});
