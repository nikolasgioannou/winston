import { isXmlText } from "@winston/contracts/messages";

export const transcriptionModel = "openai/gpt-transcribe";
export class TranscriptionError extends Error {
  constructor(readonly code: "invalid_audio" | "unavailable" | "canceled") {
    super(`Voice transcription ${code}.`);
  }
}

function validateOpus(bytes: Uint8Array) {
  if (bytes.byteLength < 64 || bytes.byteLength > 20_000_000)
    throw new TranscriptionError("invalid_audio");
  const audio = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  let packets = 0;
  let sequence = 0;
  let serial: number | undefined;
  let ended = false;
  while (offset < audio.length) {
    if (
      ended ||
      offset + 27 > audio.length ||
      audio.toString("ascii", offset, offset + 4) !== "OggS" ||
      audio.readUInt8(offset + 4) !== 0
    )
      throw new TranscriptionError("invalid_audio");
    const segments = audio.readUInt8(offset + 26);
    const start = offset + 27 + segments;
    if (start > audio.length) throw new TranscriptionError("invalid_audio");
    let length = 0;
    for (let segment = 0; segment < segments; segment += 1) {
      const value = audio.readUInt8(offset + 27 + segment);
      length += value;
      if (value < 255) packets += 1;
    }
    if (start + length > audio.length || audio.readUInt32LE(offset + 18) !== sequence)
      throw new TranscriptionError("invalid_audio");
    const currentSerial = audio.readUInt32LE(offset + 14);
    if (serial !== undefined && serial !== currentSerial)
      throw new TranscriptionError("invalid_audio");
    serial = currentSerial;
    if (sequence === 0 && (length < 19 || audio.toString("ascii", start, start + 8) !== "OpusHead"))
      throw new TranscriptionError("invalid_audio");
    ended = (audio.readUInt8(offset + 5) & 4) !== 0;
    sequence += 1;
    offset = start + length;
  }
  if (!ended || packets <= 2) throw new TranscriptionError("invalid_audio");
}

export function createVoiceTranscriber(apiKey: string) {
  if (!apiKey.trim()) throw new Error("OpenRouter key is required.");
  return async (bytes: Uint8Array, signal: AbortSignal) => {
    validateOpus(bytes);
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(90_000)]);
    try {
      deadline.throwIfAborted();
      const form = new FormData();
      form.set("model", transcriptionModel);
      form.set("response_format", "json");
      form.set("file", new Blob([Uint8Array.from(bytes)], { type: "audio/ogg" }), "voice.ogg");
      const response = await fetch("https://openrouter.ai/api/v1/audio/transcriptions", {
        method: "POST",
        redirect: "error",
        credentials: "omit",
        signal: deadline,
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new TranscriptionError("unavailable");
      }
      const reader = response.body.getReader();
      const cancel = () => {
        void reader.cancel().catch(() => undefined);
      };
      deadline.addEventListener("abort", cancel, { once: true });
      let result: unknown;
      try {
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          deadline.throwIfAborted();
          const chunk = await reader.read();
          if (chunk.done) break;
          const value: unknown = chunk.value;
          if (!(value instanceof Uint8Array)) throw new TranscriptionError("unavailable");
          size += value.byteLength;
          if (size > 1_048_576) throw new TranscriptionError("unavailable");
          chunks.push(value);
        }
        deadline.throwIfAborted();
        result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } finally {
        deadline.removeEventListener("abort", cancel);
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      if (
        !result ||
        typeof result !== "object" ||
        !("text" in result) ||
        typeof result.text !== "string" ||
        !result.text.trim() ||
        result.text.length > 200_000 ||
        !isXmlText(result.text)
      )
        throw new TranscriptionError("unavailable");
      return { text: result.text.trim(), provider: "openrouter", model: transcriptionModel };
    } catch (error) {
      if (signal.aborted) throw new TranscriptionError("canceled");
      if (error instanceof TranscriptionError) throw error;
      // Never propagate provider bodies, request headers or transport errors containing credentials.
      throw new TranscriptionError("unavailable");
    }
  };
}
