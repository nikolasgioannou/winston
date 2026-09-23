import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  createVoiceTranscriber,
  TranscriptionError,
  transcriptionModel,
} from "@winston/adapters/models";

// Structural fixture only; live codec compatibility is validated separately with synthetic speech.
function fixture() {
  return Buffer.concat(
    [
      Buffer.concat([Buffer.from("OpusHead"), Buffer.alloc(11)]),
      Buffer.from("OpusTags"),
      Buffer.from("audio"),
    ].map((packet, sequence) => {
      const page = Buffer.alloc(28 + packet.length);
      page.write("OggS");
      page.writeUInt8(sequence === 2 ? 4 : 0, 5);
      page.writeUInt32LE(sequence, 18);
      page.writeUInt8(1, 26);
      page.writeUInt8(packet.length, 27);
      packet.copy(page, 28);
      return page;
    }),
  );
}

test("voice transcription validates audio and bounds, sanitizes and cancels provider responses", async () => {
  const originalFetch = globalThis.fetch;
  const transcribe = createVoiceTranscriber("synthetic-key");
  const bytes = fixture();
  let body = JSON.stringify({ text: "Water the plants tomorrow." });
  let status = 200;
  let calls = 0;
  let failed = false;
  let stalled: AbortController | undefined;
  let canceled = false;
  try {
    globalThis.fetch = Object.assign(
      (url: string | URL | Request, init?: RequestInit) => {
        calls += 1;
        assert.equal(url, "https://openrouter.ai/api/v1/audio/transcriptions");
        assert.equal(init?.redirect, "error");
        assert.ok(init.body instanceof FormData);
        assert.equal(init.body.get("model"), transcriptionModel);
        assert.equal(init.body.get("response_format"), "json");
        const file = init.body.get("file");
        assert.ok(file instanceof Blob);
        assert.equal(file.type, "audio/ogg");
        assert.equal(file.size, bytes.length);
        if (failed) return Promise.reject(new Error("secret synthetic-key provider body"));
        if (stalled) {
          const controller = stalled;
          queueMicrotask(() => {
            controller.abort();
          });
          return Promise.resolve(
            new Response(
              new ReadableStream({
                cancel() {
                  canceled = true;
                },
              }),
            ),
          );
        }
        return Promise.resolve(new Response(body, { status }));
      },
      { preconnect: () => {} },
    );
    const signal = new AbortController().signal;
    for (const invalid of [
      Buffer.alloc(0),
      Buffer.alloc(100),
      bytes.subarray(0, bytes.length - 1),
      Buffer.alloc(20_000_001),
    ])
      await assert.rejects(
        transcribe(invalid, signal),
        (error) => error instanceof TranscriptionError && error.code === "invalid_audio",
      );
    assert.equal(calls, 0);
    assert.deepEqual(await transcribe(bytes, signal), {
      text: "Water the plants tomorrow.",
      provider: "openrouter",
      model: transcriptionModel,
    });
    for (const invalid of [
      "not json",
      JSON.stringify({ text: "" }),
      JSON.stringify({ text: "\u0000" }),
      "x".repeat(1_048_577),
    ]) {
      body = invalid;
      await assert.rejects(transcribe(bytes, signal), {
        message: "Voice transcription unavailable.",
      });
    }
    status = 429;
    await assert.rejects(transcribe(bytes, signal), {
      message: "Voice transcription unavailable.",
    });
    failed = true;
    await assert.rejects(transcribe(bytes, signal), {
      message: "Voice transcription unavailable.",
    });
    failed = false;
    stalled = new AbortController();
    await assert.rejects(transcribe(bytes, stalled.signal), {
      message: "Voice transcription canceled.",
    });
    assert.equal(canceled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
