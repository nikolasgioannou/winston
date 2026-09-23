import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  createTelegramDocumentSender,
  maximumTelegramDocumentBytes,
} from "@winston/adapters/telegram";

test("Telegram documents use bounded multipart bytes and preserve ambiguous outcomes", async () => {
  const originalFetch = globalThis.fetch;
  const send = createTelegramDocumentSender("123:synthetic");
  const document = {
    name: "report.txt",
    bytes: new TextEncoder().encode("fixture"),
    caption: "<b>literal caption</b>",
  };
  let calls = 0;
  let result: unknown = { ok: true, result: { message_id: 42 } };
  let fail = false;
  try {
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        calls++;
        assert.equal(input, "https://api.telegram.org/bot123:synthetic/sendDocument");
        assert.equal(init?.redirect, "error");
        assert.ok(init.body instanceof FormData);
        assert.equal(init.body.get("chat_id"), "123");
        assert.equal(init.body.get("caption"), document.caption);
        assert.equal(init.body.get("disable_content_type_detection"), "true");
        assert.equal(init.body.get("parse_mode"), null);
        const file = init.body.get("document");
        assert.ok(file instanceof File);
        assert.equal(file.name, "report.txt");
        assert.equal(await file.text(), "fixture");
        if (fail) throw new Error("Credential-bearing URL must not escape");
        return Response.json(result);
      },
      { preconnect: () => {} },
    );
    const signal = new AbortController().signal;
    assert.deepEqual(await send("123", document, signal), { state: "sent", messageId: 42 });
    result = { ok: false, error_code: 429, parameters: { retry_after: 8 } };
    assert.deepEqual(await send("123", document, signal), { state: "retry", afterSeconds: 8 });
    result = { ok: false, error_code: 400 };
    assert.deepEqual(await send("123", document, signal), { state: "rejected" });
    result = { ok: true, result: { message_id: 0 } };
    assert.deepEqual(await send("123", document, signal), { state: "uncertain" });
    fail = true;
    assert.deepEqual(await send("123", document, signal), { state: "uncertain" });
    assert.equal(calls, 5);

    for (const invalid of [
      { ...document, name: "../report.txt" },
      { ...document, caption: "x".repeat(1025) },
      { ...document, bytes: new Uint8Array() },
      { ...document, bytes: new Uint8Array(maximumTelegramDocumentBytes + 1) },
    ])
      assert.deepEqual(await send("123", invalid, signal), { state: "rejected" });
    assert.deepEqual(await send("@someone_else", document, signal), { state: "rejected" });
    assert.deepEqual(await send("123", document, AbortSignal.abort()), {
      state: "retry",
      afterSeconds: 1,
    });
    assert.equal(calls, 5);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
