import assert from "node:assert/strict";
import { test } from "bun:test";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { z } from "zod";
import { createModelAdapter } from "@winston/adapters/models";

function adapter(response: () => Response, timeoutMs = 1000) {
  const provider = createOpenRouter({
    apiKey: "synthetic-key",
    fetch: Object.assign(() => Promise.resolve(response()), { preconnect: () => {} }),
  });

  return createModelAdapter({ model: () => provider("openai/gpt-5.6-luna"), timeoutMs });
}

function stream(delta: object, reason = "stop") {
  const chunks = [
    { choices: [{ index: 0, delta, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: reason }] },
  ];

  return new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
    {
      headers: { "content-type": "text/event-stream" },
    },
  );
}

const request = () => ({
  role: "conversation" as const,
  messages: [{ role: "user" as const, content: "Hello" }],
  signal: new AbortController().signal,
});

test("model adapter returns complete text with content-free attempt metadata", async () => {
  const result = await adapter(() => stream({ content: "Hello owner" })).generate(request());
  assert.equal(result.ok, true);
  assert.equal(result.text, "Hello owner");
  assert.deepEqual(result.toolCalls, []);
  assert.equal(result.attempt.promptVersion, "conversation-4");
  assert.ok(result.attempt.firstTextMs !== null);
  assert.equal(JSON.stringify(result.attempt).includes("Hello"), false);
});

test("tool inputs are validated and returned without ever executing callbacks", async () => {
  let executions = 0;
  const tools = {
    status: {
      description: "Read a task status.",
      inputSchema: z.strictObject({ taskId: z.uuid() }),
      execute: () => {
        executions += 1;
      },
    },
  };
  for (const input of [{ taskId: "bad" }, { taskId: "7a43fd20-818e-45d4-8e19-6b79cef9e4f4" }]) {
    const result = await adapter(() =>
      stream(
        {
          tool_calls: [
            {
              index: 0,
              id: "call-1",
              type: "function",
              function: { name: "status", arguments: JSON.stringify(input) },
            },
          ],
        },
        "tool_calls",
      ),
    ).generate({ ...request(), tools });
    if (input.taskId === "bad") {
      assert.equal(result.ok, false);
      assert.equal(result.code, "invalid-output");
      assert.equal("toolCalls" in result, false);
    } else {
      assert.equal(result.ok, true);
      assert.deepEqual(result.toolCalls, [{ id: "call-1", name: "status", input }]);
    }
  }
  assert.equal(executions, 0);
});

test("provider failures are classified without leaking error text or retrying implicitly", async () => {
  for (const [status, expected] of [
    [401, "credentials"],
    [429, "throttled"],
    [503, "unavailable"],
  ] as const) {
    let calls = 0;
    const result = await adapter(() => {
      calls += 1;
      return Response.json(
        { error: { code: status, message: "sensitive-provider-detail" } },
        { status },
      );
    }).generate(request());
    assert.equal(result.ok, false);
    assert.equal(result.code, expected);
    assert.equal(calls, 1);
    assert.equal(JSON.stringify(result).includes("sensitive-provider-detail"), false);
  }
});

test("cancellation and timeout remain distinct and incomplete output is never returned", async () => {
  const canceled = new AbortController();
  canceled.abort();
  let calls = 0;
  const result = await adapter(() => {
    calls += 1;
    return stream({ content: "unused" });
  }).generate({ ...request(), signal: canceled.signal });
  assert.equal(result.ok, false);
  assert.equal(result.code, "canceled");
  assert.equal(calls, 0);

  const stalled = await adapter(
    () => new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } }),
    20,
  ).generate(request());
  assert.equal(stalled.ok, false);
  assert.equal(stalled.code, "timeout");

  const incomplete = await adapter(() => stream({ content: "partial" }, "length")).generate(
    request(),
  );
  assert.equal(incomplete.ok, false);
  assert.equal(incomplete.code, "incomplete");
  assert.equal("text" in incomplete, false);
});
