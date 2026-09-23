import { createHash } from "node:crypto";
import { telegramFileResponseSchema } from "@winston/contracts/telegram";

export const maximumTelegramDownloadBytes = 20_000_000;
export class TelegramDownloadError extends Error {
  constructor(readonly code: "too_large" | "unavailable" | "canceled") {
    super(`Telegram attachment ${code}.`);
  }
}

async function readBytes(response: Response, maximum: number, signal: AbortSignal) {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new TelegramDownloadError("unavailable");
  }
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) {
    await response.body.cancel();
    throw new TelegramDownloadError(Number(length) > maximum ? "too_large" : "unavailable");
  }
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    const chunks: Uint8Array[] = [];
    let size = 0;
    let chunk = await reader.read();
    while (!chunk.done) {
      signal.throwIfAborted();
      const value: unknown = chunk.value;
      if (!(value instanceof Uint8Array)) throw new TelegramDownloadError("unavailable");
      size += value.byteLength;
      if (size > maximum) throw new TelegramDownloadError("too_large");
      chunks.push(value);
      chunk = await reader.read();
    }
    signal.throwIfAborted();
    if (length !== null && !response.headers.has("content-encoding") && Number(length) !== size)
      throw new TelegramDownloadError("unavailable");
    return Buffer.concat(chunks, size);
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

// File IDs must come from the owner's authenticated inbox. No credential-bearing URL escapes.
export function createTelegramDownloader(token: string) {
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new Error("Telegram token is invalid.");
  return async (fileId: string, signal: AbortSignal, expectedSize?: number) => {
    if (
      !fileId ||
      fileId.length > 2048 ||
      (expectedSize !== undefined && (!Number.isSafeInteger(expectedSize) || expectedSize < 0))
    )
      throw new TelegramDownloadError("unavailable");
    if (expectedSize !== undefined && expectedSize > maximumTelegramDownloadBytes)
      throw new TelegramDownloadError("too_large");
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(45_000)]);
    try {
      deadline.throwIfAborted();
      const response = await fetch(`https://api.telegram.org/bot${token}/getFile`, {
        method: "POST",
        redirect: "error",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_id: fileId }),
        signal: deadline,
      });
      const result = telegramFileResponseSchema.parse(
        JSON.parse((await readBytes(response, 65_536, deadline)).toString("utf8")),
      ).result;
      if (result.file_size !== undefined && result.file_size > maximumTelegramDownloadBytes)
        throw new TelegramDownloadError("too_large");
      if (
        expectedSize !== undefined &&
        result.file_size !== undefined &&
        result.file_size !== expectedSize
      )
        throw new TelegramDownloadError("unavailable");
      if (
        result.file_path
          .split("/")
          .some((part) => !/^[A-Za-z0-9_.-]+$/.test(part) || part === "." || part === "..")
      )
        throw new TelegramDownloadError("unavailable");
      const downloaded = await fetch(
        `https://api.telegram.org/file/bot${token}/${result.file_path}`,
        {
          redirect: "error",
          signal: deadline,
        },
      );
      const bytes = await readBytes(downloaded, maximumTelegramDownloadBytes, deadline);
      const size = expectedSize ?? result.file_size;
      if (size !== undefined && bytes.byteLength !== size)
        throw new TelegramDownloadError("unavailable");
      return {
        bytes,
        size: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    } catch (error) {
      if (signal.aborted) throw new TelegramDownloadError("canceled");
      if (error instanceof TelegramDownloadError) throw error;
      // Transport and parsing errors can contain the token URL or provider response.
      throw new TelegramDownloadError("unavailable");
    }
  };
}
