import assert from "node:assert/strict";
import { test } from "bun:test";
import { createTelegramTypingSender } from "@winston/adapters/telegram";

test("typing transport is ephemeral, abortable, rate-limited and never exposes credential errors", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  let status = 200;
  try {
    globalThis.fetch = Object.assign(
      (_input: string | URL | Request, init?: RequestInit) => {
        calls++;
        assert.ok(init && typeof init.body === "string");
        assert.deepEqual(JSON.parse(init.body), { chat_id: "123", action: "typing" });
        assert.equal(init.redirect, "error");
        assert.ok(init.signal);
        return Promise.resolve(Response.json({ ok: status === 200, result: true }, { status }));
      },
      { preconnect: () => {} },
    );
    const send = createTelegramTypingSender("123:synthetic");
    const signal = new AbortController().signal;
    assert.equal(await send("123", signal), true);
    assert.equal(await send("bad", signal), false);
    assert.equal(await send("123", AbortSignal.abort()), false);
    assert.equal(calls, 1);
    status = 429;
    assert.equal(await send("123", signal), false);
    assert.equal(await send("123", signal), false);
    assert.equal(calls, 2);
    globalThis.fetch = Object.assign(
      () => Promise.reject(new Error("https://api.telegram.org/bot123:synthetic/sendChatAction")),
      { preconnect: () => {} },
    );
    assert.equal(await createTelegramTypingSender("123:synthetic")("123", signal), false);
    globalThis.fetch = Object.assign(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          assert.ok(init?.signal);
          init.signal.addEventListener(
            "abort",
            () => {
              reject(new Error("Timeout"));
            },
            { once: true },
          );
        }),
      { preconnect: () => {} },
    );
    assert.equal(await createTelegramTypingSender("123:synthetic")("123", signal), false);
  } finally {
    globalThis.fetch = original;
  }
});
