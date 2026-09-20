import assert from "node:assert/strict";
import { test } from "bun:test";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { APICallError } from "ai";
import { collectReply, ConversationRevision } from "../models/conversation";

function fakeModel(response: () => Response) {
  return createOpenRouter({
    apiKey: "synthetic-test-key",
    fetch: Object.assign(() => Promise.resolve(response()), {
      preconnect: () => {
        // This transport never opens a network connection.
      },
    }),
  })("openai/gpt-5.6-luna");
}

function streamResponse(finishReason: string = "stop") {
  const chunks = [
    { choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: finishReason }] },
  ];
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("");

  return new Response(`${body}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}

test("three messages invalidate prior generations even if transport finishes late", async () => {
  const conversation = new ConversationRevision();
  const first = conversation.advance();
  const second = conversation.advance();
  const third = conversation.advance();
  const sent: string[] = [];
  const send = (text: string) => {
    sent.push(text);
  };

  const reply = await collectReply(
    fakeModel(streamResponse),
    [{ role: "user", content: "Hello" }],
    third.signal,
    undefined,
    "Reply briefly.",
  );

  assert.equal(first.publish("stale first", send), false);
  assert.equal(second.publish("stale second", send), false);
  assert.equal(third.publish(reply.text, send), true);
  assert.deepEqual(sent, ["Hello"]);
});

test("superseding a completed generation before publication rejects it", async () => {
  const conversation = new ConversationRevision();
  const first = conversation.advance();
  const reply = await collectReply(
    fakeModel(streamResponse),
    [{ role: "user", content: "Hello" }],
    first.signal,
  );

  conversation.advance();

  assert.equal(
    first.publish(reply.text, () => {
      assert.fail("A superseded reply must not publish.");
    }),
    false,
  );
});

test("cancellation after the first streamed token rejects partial output", async () => {
  const controller = new AbortController();

  await assert.rejects(
    collectReply(
      fakeModel(streamResponse),
      [{ role: "user", content: "Hello" }],
      controller.signal,
      () => {
        controller.abort();
      },
    ),
    { name: "AbortError" },
  );
});

test("token-limited output cannot become a completed reply", async () => {
  await assert.rejects(
    collectReply(
      fakeModel(() => streamResponse("length")),
      [{ role: "user", content: "Hello" }],
      new AbortController().signal,
    ),
    /did not complete/,
  );
});

test("provider errors propagate without retrying or publishing partial text", async () => {
  for (const status of [401, 429, 503]) {
    let calls = 0;
    const model = fakeModel(() => {
      calls += 1;

      return Response.json({ error: { message: "Synthetic failure", code: status } }, { status });
    });

    await assert.rejects(
      collectReply(model, [{ role: "user", content: "Hello" }], new AbortController().signal),
      (error: unknown) => APICallError.isInstance(error) && error.statusCode === status,
    );

    assert.equal(calls, 1);
  }
});

test("an error after streamed text rejects the entire reply", async () => {
  const model = fakeModel(
    () =>
      new Response(
        'data: {"choices":[{"index":0,"delta":{"content":"Partial"},"finish_reason":null}]}\n\n' +
          'data: {"error":{"message":"Synthetic stream failure","code":503}}\n\n' +
          "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      ),
  );

  await assert.rejects(
    collectReply(model, [{ role: "user", content: "Hello" }], new AbortController().signal),
  );
});
