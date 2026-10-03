import { describe, expect, test } from "bun:test";
import { isStepCount, tool, type ModelMessage } from "ai";
import { z } from "zod";
import { cacheBreakpoint, withRollingBreakpoint } from "./cache.ts";
import { fakeGateway, testRun } from "./testing.ts";

describe("model gateway", () => {
  test("pins Anthropic with no fallbacks, sends the profile's effort, and asks for usage", async () => {
    const { gateway, requests } = fakeGateway();
    await gateway.generate({
      profile: "background",
      run: testRun(),
      prompt: "hi",
    });
    expect(requests[0]).toMatchObject({
      model: "anthropic/claude-opus-5.5",
      // The privacy policy depends on data_collection: deny.
      provider: {
        order: ["anthropic"],
        allow_fallbacks: false,
        data_collection: "deny",
      },
      reasoning: { effort: "high" },
      usage: { include: true },
    });
    await gateway.generate({ profile: "front", run: testRun(), prompt: "hi" });
    expect(requests[1]).toMatchObject({
      model: "anthropic/claude-sonnet-5",
      reasoning: { effort: "low" },
    });
  });

  test("cache breakpoints reach the request", async () => {
    const { gateway, requests } = fakeGateway();
    const messages: ModelMessage[] = [
      cacheBreakpoint({
        role: "user",
        content: [{ type: "text", text: "earlier" }],
      }),
      { role: "user", content: "now" },
    ];
    await gateway.generate({
      profile: "front",
      run: testRun(),
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

  test("breakpoints go where the provider forwards them, keeping other provider options", () => {
    const system = cacheBreakpoint<ModelMessage>({
      role: "system",
      content: "x",
      providerOptions: { anthropic: { a: true } },
    });
    expect(system.providerOptions).toEqual({
      anthropic: { a: true },
      openrouter: { cacheControl: { type: "ephemeral" } },
    });
    // A user message's marker goes on its last text part.
    expect(
      cacheBreakpoint<ModelMessage>({ role: "user", content: "hi" }),
    ).toEqual({
      role: "user",
      content: [
        {
          type: "text",
          text: "hi",
          providerOptions: {
            openrouter: { cacheControl: { type: "ephemeral" } },
          },
        },
      ],
    });
    // The provider drops it on assistant messages, so that's refused.
    expect(() =>
      cacheBreakpoint<ModelMessage>({ role: "assistant", content: "x" }),
    ).toThrow();
  });

  test("parallel tool results carry one marker between them, within Anthropic's four", async () => {
    const { gateway, requests } = fakeGateway();
    const ids = ["call_1", "call_2", "call_3", "call_4", "call_5"];
    await gateway.generate({
      profile: "front",
      run: testRun(),
      instructions: cacheBreakpoint({ role: "system", content: "sys" }, "1h"),
      messages: withRollingBreakpoint(
        [
          { role: "user", content: "check five things" },
          {
            role: "assistant",
            content: ids.map((toolCallId) => ({
              type: "tool-call",
              toolCallId,
              toolName: "bash",
              input: {},
            })),
          },
          {
            role: "tool",
            content: ids.map((toolCallId) => ({
              type: "tool-result",
              toolCallId,
              toolName: "bash",
              output: { type: "text", value: "ok" },
            })),
          },
        ],
        "1h",
      ),
    });
    const sent = requests[0]?.messages as {
      role: string;
      tool_call_id?: string;
      cache_control?: unknown;
    }[];
    expect(JSON.stringify(sent).match(/"cache_control"/g)).toHaveLength(2);
    // The system prompt's, and the last result's: the cache covers all five.
    expect(
      sent
        .filter((m) => m.role === "tool" && m.cache_control)
        .map((m) => m.tool_call_id),
    ).toEqual(["call_5"]);
  });

  test("rejects sampling settings and forced tool choice before sending", async () => {
    const { gateway, requests } = fakeGateway();
    const base = { profile: "front" as const, run: testRun(), prompt: "hi" };
    for (const settings of [{ temperature: 0.2 }, { topP: 0.9 }, { topK: 5 }]) {
      const error = await gateway
        .generate({ ...base, ...settings })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
    }
    const forced = await gateway
      .generate({ ...base, toolChoice: "required" })
      .catch((e: unknown) => e);
    expect(forced).toBeInstanceOf(Error);
    expect(requests).toEqual([]);
  });
});

describe("recording", () => {
  test("every step is recorded with the run, step number and context range, before the caller's onStepEnd", async () => {
    const order: string[] = [];
    let stored = 10;
    const { gateway } = fakeGateway({
      sink: (call) => {
        order.push(
          `record ${String(call.step)} (context to ${String(call.contextToMessageId)})`,
        );
        return Promise.resolve();
      },
    });
    await gateway.generate({
      profile: "front",
      run: testRun({
        contextRange: () => ({ fromMessageId: 1, toMessageId: stored }),
      }),
      prompt: "hi",
      onStepEnd: () => {
        stored += 2;
        order.push("caller stores the step");
      },
    });
    expect(order).toEqual([
      "record 0 (context to 10)",
      "caller stores the step",
    ]);
  });

  test("records the call's usage, cost, provider and stop reason", async () => {
    const { gateway, calls } = fakeGateway();
    await gateway.generate({ profile: "front", run: testRun(), prompt: "hi" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      model: "anthropic/claude-sonnet-5",
      provider: "Anthropic",
      inputTokens: 1200,
      cachedTokens: 1000,
      cacheWriteTokens: 150,
      outputTokens: 40,
      reasoningTokens: 12,
      costUsd: 0.00123,
      stopReason: "stop",
      profile: "front",
      step: 0,
    });
  });

  test("a tool loop records one call per step", async () => {
    let lookups = 0;
    const { gateway, calls } = fakeGateway({
      replies: [
        {
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "lookup", arguments: "{}" },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
        {},
      ],
    });
    await gateway.generate({
      profile: "front",
      run: testRun(),
      prompt: "hi",
      stopWhen: isStepCount(5),
      tools: {
        lookup: tool({
          inputSchema: z.object({}),
          execute: () => {
            lookups += 1;
            return Promise.resolve("found");
          },
        }),
      },
    });
    expect(lookups).toBe(1);
    expect(calls.map((call) => [call.step, call.stopReason])).toEqual([
      [0, "tool-calls"],
      [1, "stop"],
    ]);
  });

  test("a call's latency is the model's, without its tool calls", async () => {
    const { gateway, calls } = fakeGateway({
      replies: [
        {
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "slow", arguments: "{}" },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
      ],
    });
    await gateway.generate({
      profile: "front",
      run: testRun(),
      prompt: "hi",
      stopWhen: isStepCount(1),
      tools: {
        slow: tool({
          inputSchema: z.object({}),
          execute: async () => {
            await Bun.sleep(100);
            return "done";
          },
        }),
      },
    });
    expect(calls[0]?.latencyMs).toBeLessThan(50);
  });

  test("reports a refusal as such", async () => {
    const { gateway, calls } = fakeGateway({
      replies: [
        {
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "" },
              finish_reason: "refusal",
            },
          ],
        },
      ],
    });
    await gateway.generate({ profile: "front", run: testRun(), prompt: "hi" });
    expect(calls[0]?.stopReason).toBe("refusal");
  });
});
