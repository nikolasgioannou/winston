import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import type { CommandOutput } from "@winston/contracts/commands";

export function commandOutput() {
  const hash = createHash("sha256");
  const preview = Buffer.alloc(1024);
  let previewLength = 0;
  let bytes = 0;
  let truncated = false;

  return {
    async capture(
      stream: ReadableStream<Uint8Array>,
      file: FileHandle,
      remaining: (bytes: number) => number,
    ) {
      const reader = stream.getReader();
      try {
        for (;;) {
          const item = await reader.read();
          if (item.done) break;
          const count = remaining(item.value.byteLength);
          const chunk = item.value.subarray(0, count);
          truncated ||= count < item.value.byteLength;
          let offset = 0;
          while (offset < count) {
            const written = await file.write(chunk, offset, count - offset);
            if (written.bytesWritten === 0)
              throw new Error("Output storage stopped accepting bytes.");
            offset += written.bytesWritten;
          }
          hash.update(chunk);
          bytes += count;
          const copied = Math.min(preview.byteLength - previewLength, count);
          preview.set(chunk.subarray(0, copied), previewLength);
          previewLength += copied;
        }
      } catch (error) {
        truncated = true;
        throw error;
      } finally {
        reader.releaseLock();
      }
    },
    finish(): CommandOutput {
      return {
        bytes,
        sha256: hash.digest("hex"),
        preview: preview.subarray(0, previewLength).toString("utf8"),
        truncated: truncated || bytes > previewLength,
      };
    },
  };
}
