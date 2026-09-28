/**
 * Speech to text through OpenRouter's `/api/v1/audio/transcriptions`
 * (docs/design.md §4, Media). Neither the AI SDK nor OpenRouter's provider
 * covers it yet, so this is a plain `fetch`. Telegram's OGG/Opus voice notes
 * and MP4 round videos are accepted as they are (verified).
 */
import { z } from "zod";

/** The model voice notes are transcribed with: the best formatting of those tried, about $0.002 a minute. */
export const transcriptionModel = "openai/gpt-4o-mini-transcribe";

export interface Transcriber {
  transcribe(
    audio: Uint8Array,
    format: "ogg" | "mp4",
  ): Promise<{ text: string; costUsd: number }>;
}

const responseSchema = z.object({
  text: z.string(),
  usage: z.object({ cost: z.number() }).partial().optional(),
});

export function openRouterTranscriber({
  apiKey,
  fetch = globalThis.fetch,
  timeoutMs = 60_000,
}: {
  apiKey: string;
  /** For tests: a fake `fetch`. */
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}): Transcriber {
  return {
    async transcribe(audio, format) {
      const response = await fetch(
        "https://openrouter.ai/api/v1/audio/transcriptions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: transcriptionModel,
            input_audio: {
              data: Buffer.from(audio).toString("base64"),
              format,
            },
          }),
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
      if (!response.ok)
        throw new Error(
          `Transcription failed with ${String(response.status)}: ${(await response.text()).slice(0, 200)}`,
        );
      const body = responseSchema.parse(await response.json());
      return { text: body.text, costUsd: body.usage?.cost ?? 0 };
    },
  };
}
