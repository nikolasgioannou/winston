import assert from "node:assert/strict";
import { test } from "bun:test";
import { buildModelWindow, type ConversationExchange } from "@winston/adapters/models";

const user = (id: string, content = id): ConversationExchange => ({
  id,
  messages: [{ role: "user", content }],
});
const settings = {
  revision: 3,
  maxMessages: 1000,
  contextTokens: 1_050_000,
  outputTokens: 4096,
  fixedContext: "Trusted instructions and tools",
};

test("rolling count window retains original chronology and does not change durable input", () => {
  const exchanges = [user("one"), user("two"), user("three")];
  const before = structuredClone(exchanges);
  const result = buildModelWindow({ ...settings, exchanges, maxMessages: 2 });
  assert.equal(result.kind, "ready");
  assert.deepEqual(
    result.messages.map((message) => message.content),
    ["two", "three"],
  );
  assert.equal(result.omittedExchanges, 1);
  assert.equal(result.revision, 3);
  assert.deepEqual(exchanges, before);
});

test("capacity eviction includes output and fixed context headroom and keeps tool exchanges whole", () => {
  const tools: ConversationExchange = {
    id: "tools",
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call-1", toolName: "status", input: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "status",
            output: { type: "json", value: { state: "running" } },
          },
        ],
      },
    ],
  };
  const exchanges = [user("old", "x".repeat(2000)), tools, user("latest", "new request")];
  const result = buildModelWindow({
    ...settings,
    exchanges,
    contextTokens: 2000,
    outputTokens: 500,
    framingTokens: 64,
  });
  assert.equal(result.kind, "ready");
  assert.equal(result.messages.length, 3);
  assert.equal(result.omittedExchanges, 1);
  assert.ok(result.estimatedInputTokens + 500 <= 2000);
  const countBound = buildModelWindow({ ...settings, exchanges, maxMessages: 2 });
  assert.equal(countBound.kind, "ready");
  assert.deepEqual(countBound.messages, exchanges[2]?.messages);
  const larger = buildModelWindow({ ...settings, exchanges });
  assert.equal(larger.kind, "ready");
  assert.equal(larger.omittedExchanges, 0);
});

test("oversized latest request is explicit and orphan tool results are rejected", () => {
  const result = buildModelWindow({
    ...settings,
    exchanges: [user("old"), user("latest", "x".repeat(5000))],
    contextTokens: 2000,
    outputTokens: 500,
    framingTokens: 64,
  });
  assert.deepEqual(result, {
    kind: "requires-reference",
    revision: 3,
    exchangeId: "latest",
    reason: "capacity",
  });
  const orphan: ConversationExchange = {
    id: "orphan",
    messages: [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "missing",
            toolName: "status",
            output: { type: "text", value: "result" },
          },
        ],
      },
    ],
  };
  assert.throws(() => buildModelWindow({ ...settings, exchanges: [orphan] }), /Orphan/);
});

test("window assembly preserves timestamp XML and needs no provider or summary call", () => {
  const content =
    '<user_message><user_content>cancel it</user_content><system_event><sent_at timezone="UTC">2026-09-22T00:00:00+00:00</sent_at></system_event></user_message>';
  const result = buildModelWindow({
    ...settings,
    revision: 4,
    exchanges: [user("latest", content)],
  });
  assert.equal(result.kind, "ready");
  assert.equal(result.messages[0]?.content, content);
  assert.equal(result.revision, 4);
});

test("the initial thousand-message cap fits short messages and capacity bounds longer history", () => {
  const short = Array.from({ length: 1000 }, (_, index) => user(String(index), "x".repeat(200)));
  const complete = buildModelWindow({ ...settings, exchanges: short });
  assert.equal(complete.kind, "ready");
  assert.equal(complete.messages.length, 1000);
  const long = short.map((exchange) => user(exchange.id, "x".repeat(4096)));
  const bounded = buildModelWindow({ ...settings, exchanges: long });
  assert.equal(bounded.kind, "ready");
  assert.ok(bounded.messages.length < 1000);
  assert.ok(bounded.estimatedInputTokens + settings.outputTokens <= settings.contextTokens);
});
