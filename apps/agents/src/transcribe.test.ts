import { expect, test } from "bun:test";
import { openRouterTranscriber, transcriptionModel } from "./transcribe.ts";

test("sends base64 audio with its format and reads the text and cost", async () => {
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  const transcriber = openRouterTranscriber({
    apiKey: "test",
    fetch: ((url: string, init?: RequestInit) => {
      requests.push({
        url,
        body: JSON.parse(init?.body as string) as Record<string, unknown>,
      });
      return Promise.resolve(
        Response.json({
          text: "Remind me to call Dana.",
          usage: { cost: 0.0001775 },
        }),
      );
    }) as unknown as typeof fetch,
  });
  const result = await transcriber.transcribe(new Uint8Array([1, 2, 3]), "ogg");
  expect(result).toEqual({
    text: "Remind me to call Dana.",
    costUsd: 0.0001775,
  });
  expect(requests[0]?.url).toBe(
    "https://openrouter.ai/api/v1/audio/transcriptions",
  );
  expect(requests[0]?.body).toEqual({
    model: transcriptionModel,
    input_audio: { data: "AQID", format: "ogg" },
  });
});

test("an error response throws, so the job retries", async () => {
  const transcriber = openRouterTranscriber({
    apiKey: "test",
    fetch: (() =>
      Promise.resolve(
        new Response("bad gateway", { status: 502 }),
      )) as unknown as typeof fetch,
  });
  const error = await transcriber
    .transcribe(new Uint8Array([1]), "mp4")
    .catch((e: unknown) => e);
  expect(String(error)).toContain("502");
});
