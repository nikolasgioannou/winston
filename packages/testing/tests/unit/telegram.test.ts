import assert from "node:assert/strict";
import { test } from "bun:test";
import { createTelegramClient, verifyTelegramWebhook } from "@winston/adapters/telegram";

test("Telegram transport errors never expose tokens or provider response bodies", async () => {
  const original = globalThis.fetch;
  const token = "123:synthetic-secret";
  const client = createTelegramClient(token);

  try {
    globalThis.fetch = Object.assign(
      () => Promise.reject(new Error(`Request failed https://api.telegram.org/bot${token}/getMe`)),
      { preconnect: () => {} },
    );
    await assert.rejects(client.identity(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Telegram request failed.");
      assert.ok(!error.stack?.includes(token));

      return true;
    });
    globalThis.fetch = Object.assign(
      () => Promise.resolve(Response.json({ ok: false, description: token }, { status: 401 })),
      { preconnect: () => {} },
    );
    await assert.rejects(client.identity(), /Telegram request failed\./);
  } finally {
    globalThis.fetch = original;
  }

  assert.equal(verifyTelegramWebhook(null, "secret"), false);
  assert.equal(verifyTelegramWebhook("wrong!", "secret"), false);
  assert.equal(verifyTelegramWebhook("secret", "secret"), true);
});

test("Telegram callback acknowledgment and polling use the Bot API callback fields", async () => {
  const original = globalThis.fetch;
  const requests: { url: string; body: unknown }[] = [];
  try {
    globalThis.fetch = Object.assign(
      (input: string | URL | Request, init?: RequestInit) => {
        assert.ok(init && typeof init.body === "string");
        const url = input instanceof Request ? input.url : input.toString();
        requests.push({ url, body: JSON.parse(init.body) });
        return Promise.resolve(
          Response.json({ ok: true, result: url.endsWith("getUpdates") ? [] : true }),
        );
      },
      { preconnect: () => {} },
    );
    const client = createTelegramClient("123:synthetic");
    await client.answerCallback("query", "Approved.");
    await client.updates(5, new AbortController().signal);
    assert.deepEqual(
      requests.map((request) => request.body),
      [
        { callback_query_id: "query", text: "Approved." },
        {
          offset: 5,
          timeout: 25,
          allowed_updates: ["message", "edited_message", "callback_query"],
        },
      ],
    );
    assert.ok(requests[0]?.url.endsWith("/answerCallbackQuery"));
  } finally {
    globalThis.fetch = original;
  }
});
