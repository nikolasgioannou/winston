import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "bun:test";
import {
  createTelegramDownloader,
  maximumTelegramDownloadBytes,
  TelegramDownloadError,
} from "@winston/adapters/telegram";

test("Telegram downloads keep tokens private and enforce path, byte and cancellation bounds", async () => {
  const originalFetch = globalThis.fetch;
  const download = createTelegramDownloader("123:synthetic");
  let path = "documents/file_1.txt";
  let declared = 3;
  let body = "abc";
  let header: string | undefined;
  let calls = 0;
  let fail = false;
  let stall = false;
  let canceled = false;
  try {
    globalThis.fetch = Object.assign(
      (input: string | URL | Request, init?: RequestInit) => {
        calls++;
        assert.equal(init?.redirect, "error");
        if (fail)
          return Promise.reject(new Error("https://api.telegram.org/bot123:synthetic/getFile"));
        assert.equal(typeof input, "string");
        if (typeof input !== "string") throw new Error("Expected fixed URL");
        if (input.endsWith("/getFile")) {
          assert.equal(init.body, JSON.stringify({ file_id: "fixture" }));
          return Promise.resolve(
            Response.json({
              ok: true,
              result: { file_id: "fixture", file_path: path, file_size: declared },
            }),
          );
        }
        assert.equal(input, `https://api.telegram.org/file/bot123:synthetic/${path}`);
        return Promise.resolve(
          new Response(
            stall
              ? new ReadableStream<Uint8Array>({
                  cancel() {
                    canceled = true;
                  },
                })
              : body,
            { headers: header === undefined ? {} : { "content-length": header } },
          ),
        );
      },
      { preconnect: () => {} },
    );
    const signal = new AbortController().signal;
    const result = await download("fixture", signal, 3);
    assert.equal(result.bytes.toString(), "abc");
    assert.equal(result.sha256, createHash("sha256").update("abc").digest("hex"));
    assert.deepEqual(Object.keys(result).sort(), ["bytes", "sha256", "size"]);
    for (const value of [
      "../secret",
      "/absolute",
      "documents/../secret",
      "documents/%2e%2e/secret",
      "https://other.invalid/file",
      "documents/file?token=bad",
      "documents\\file",
    ]) {
      path = value;
      const before = calls;
      await assert.rejects(
        download("fixture", signal),
        (error) => error instanceof TelegramDownloadError && error.code === "unavailable",
      );
      assert.equal(calls, before + 1);
    }
    path = "documents/file_1.txt";
    declared = maximumTelegramDownloadBytes + 1;
    await assert.rejects(
      download("fixture", signal),
      (error) => error instanceof TelegramDownloadError && error.code === "too_large",
    );
    const before = calls;
    await assert.rejects(download("fixture", signal, maximumTelegramDownloadBytes + 1));
    assert.equal(calls, before);
    declared = 3;
    body = "ab";
    await assert.rejects(download("fixture", signal), /unavailable/);
    body = "x".repeat(maximumTelegramDownloadBytes + 1);
    await assert.rejects(download("fixture", signal), /too_large/);
    body = "abc";
    header = String(maximumTelegramDownloadBytes + 1);
    await assert.rejects(download("fixture", signal), /too_large/);
    header = "4";
    await assert.rejects(download("fixture", signal), /unavailable/);
    header = undefined;
    fail = true;
    await assert.rejects(
      download("fixture", signal),
      (error) => error instanceof TelegramDownloadError && !error.message.includes("synthetic"),
    );
    fail = false;
    stall = true;
    const controller = new AbortController();
    const reading = download("fixture", controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await assert.rejects(
      reading,
      (error) => error instanceof TelegramDownloadError && error.code === "canceled",
    );
    assert.equal(canceled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
