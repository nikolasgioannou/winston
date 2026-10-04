/**
 * Images in a background run's context (docs/design.md §2, "Cheap hygiene").
 * Stored messages keep images as blob stubs, and each step rebuilds its
 * context from storage, so the newest few are put back from the blob store
 * and older ones stay stubs. The cut moves in chunks of three, so the prompt
 * prefix (and the cache) changes only every few images.
 */
import type { ModelMessage } from "ai";
import type { BlobStore } from "@winston/blobs";

/** At least this many of the newest images are shown, and at most this plus two. */
export const imagesShown = 3;

const stubPattern =
  /^\[image, stored as blob ([0-9a-f]{64}); not shown again, view it again to see it\]$/;

/** The image's type from its first bytes; PNG unless it's another we know. */
export function imageType(bytes: Uint8Array) {
  const ascii = (from: number, to: number) =>
    String.fromCharCode(...bytes.slice(from, to));
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (ascii(0, 3) === "GIF") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return "image/png";
}

/** Which of `count` images (oldest first) are shown: those after the returned index. */
export function firstShown(count: number) {
  return Math.max(0, Math.floor((count - imagesShown) / 3) * 3);
}

/** `messages` with the newest images put back in place of their stubs. */
export async function rehydrateImages(
  messages: readonly ModelMessage[],
  blobs: BlobStore,
): Promise<ModelMessage[]> {
  const count = messages.reduce(
    (total, message) => total + stubsIn(message).length,
    0,
  );
  const cut = firstShown(count);
  let seen = 0;
  const result: ModelMessage[] = [];
  for (const message of messages) {
    if (message.role !== "tool" || stubsIn(message).length === 0) {
      result.push(message);
      continue;
    }
    const content = [];
    for (const part of message.content) {
      if (part.type !== "tool-result" || part.output.type !== "content") {
        content.push(part);
        continue;
      }
      const value = [];
      for (const item of part.output.value) {
        const key = stubKey(item);
        if (key === undefined) {
          value.push(item);
          continue;
        }
        seen += 1;
        if (seen <= cut) {
          value.push(item);
          continue;
        }
        const bytes = await blobs.get(key);
        value.push({
          type: "file" as const,
          mediaType: imageType(bytes),
          data: {
            type: "data" as const,
            data: Buffer.from(bytes).toString("base64"),
          },
        });
      }
      content.push({ ...part, output: { ...part.output, value } });
    }
    result.push({ ...message, content });
  }
  return result;
}

function stubsIn(message: ModelMessage) {
  if (message.role !== "tool") return [];
  return message.content.flatMap((part) =>
    part.type === "tool-result" && part.output.type === "content"
      ? part.output.value.filter((item) => stubKey(item) !== undefined)
      : [],
  );
}

/** The blob key in an image stub, if `item` is one. */
function stubKey(item: unknown) {
  // Read through a minimal shape: some members of the SDK's part union are deprecated.
  const text = item as { type: string; text?: string };
  return text.type === "text" && text.text !== undefined
    ? stubPattern.exec(text.text)?.[1]
    : undefined;
}
