import assert from "node:assert/strict";
import { test } from "bun:test";
import { createTelegramSender, splitTelegramText } from "@winston/adapters/telegram";

test("Telegram plain text preserves URLs and Unicode without parsing markup", () => {
  const url = "https://example.com/continue?token=synthetic&next=browser";
  const parts = splitTelegramText(`${"🙂 ".repeat(2000)}<b>literal</b> ${url}`);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((part) => part.length <= 4096 && !/\p{Surrogate}/u.test(part)));
  assert.ok(parts.some((part) => part.includes(url)));
  assert.ok(parts.some((part) => part.includes("<b>literal</b>")));
  assert.throws(() => splitTelegramText(`https://example.com/${"a".repeat(4096)}`), /too long/);
});

test("Telegram sending distinguishes explicit rejection, throttling, success and unknown outcomes", async () => {
  const originalFetch = globalThis.fetch;
  const send = createTelegramSender("123:synthetic");
  try {
    const cases = [
      {
        body: { ok: true, result: { message_id: 42 } },
        status: 200,
        expected: { state: "sent", messageId: 42 },
      },
      {
        body: { ok: false, error_code: 429, parameters: { retry_after: 5 } },
        status: 429,
        expected: { state: "retry", afterSeconds: 5 },
      },
      { body: { ok: false, error_code: 403 }, status: 403, expected: { state: "rejected" } },
      { body: { ok: false, error_code: 502 }, status: 502, expected: { state: "uncertain" } },
      { body: { ok: true, result: {} }, status: 200, expected: { state: "uncertain" } },
    ];
    for (const entry of cases) {
      globalThis.fetch = Object.assign(
        () => Promise.resolve(Response.json(entry.body, { status: entry.status })),
        { preconnect: () => {} },
      );
      assert.deepEqual(await send("123", "hello", new AbortController().signal), entry.expected);
    }
    globalThis.fetch = Object.assign(
      () => Promise.reject(new Error("https://api.telegram.org/bot123:synthetic/sendMessage")),
      { preconnect: () => {} },
    );
    assert.deepEqual(await send("123", "hello", new AbortController().signal), {
      state: "uncertain",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Telegram sends validated callback buttons without enabling text markup", async () => {
  const originalFetch = globalThis.fetch;
  const keyboard = { inline_keyboard: [[{ text: "Approve", callback_data: "approve_synthetic" }]] };
  const requests: unknown[] = [];
  try {
    globalThis.fetch = Object.assign(
      (_input: string | URL | Request, init?: RequestInit) => {
        assert.ok(init && typeof init.body === "string");
        requests.push(JSON.parse(init.body));
        return Promise.resolve(Response.json({ ok: true, result: { message_id: 42 } }));
      },
      { preconnect: () => {} },
    );
    const send = createTelegramSender("123:synthetic");
    assert.deepEqual(await send("123", "Exact proposal", new AbortController().signal, keyboard), {
      state: "sent",
      messageId: 42,
    });
    assert.deepEqual(requests, [
      {
        chat_id: "123",
        text: "Exact proposal",
        link_preview_options: { is_disabled: true },
        reply_markup: keyboard,
      },
    ]);
    await send("123", "Invalid", new AbortController().signal, {
      inline_keyboard: [[{ text: "Approve", callback_data: "x".repeat(65) }]],
    });
    assert.equal(requests.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
