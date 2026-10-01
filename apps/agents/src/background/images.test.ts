import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import { localBlobStore } from "../blobs.ts";
import { firstShown, imageType, rehydrateImages } from "./images.ts";

const blobs = localBlobStore(`${tmpdir()}/winston-test-blobs`);
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

const stub = (key: string) =>
  `[image, stored as blob ${key}; not shown again, view it again to see it]`;

/** A view_image result as stored: its caption, then the stub. */
const viewed = (i: number, key: string): ModelMessage => ({
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId: `c${String(i)}`,
      toolName: "view_image",
      output: {
        type: "content",
        value: [
          { type: "text", text: `shot ${String(i)}` },
          { type: "text", text: stub(key) },
        ],
      },
    },
  ],
});

const shownCount = (messages: ModelMessage[]) =>
  JSON.stringify(messages).split('"type":"file"').length - 1;

describe("images in background runs", () => {
  test("the newest three to five are shown, and the cut moves three at a time", () => {
    expect([1, 3, 4, 5, 6, 7, 8, 9, 12].map(firstShown)).toEqual([
      0, 0, 0, 0, 3, 3, 3, 6, 9,
    ]);
  });

  test("stubs of the newest images are put back from the blob store; older ones stay stubs", async () => {
    const key = await blobs.put(png);
    const messages = Array.from({ length: 7 }, (_, i) => viewed(i, key));
    const shown = await rehydrateImages(messages, blobs);
    expect(shownCount(shown)).toBe(4);
    expect(JSON.stringify(shown[0])).toContain(stub(key));
    expect(JSON.stringify(shown[6])).toContain('"mediaType":"image/png"');
    // The stored messages themselves are untouched.
    expect(shownCount(messages)).toBe(0);
  });

  test("the image type comes from its first bytes", () => {
    expect(imageType(png)).toBe("image/png");
    expect(imageType(new Uint8Array([0xff, 0xd8, 0xff]))).toBe("image/jpeg");
    expect(imageType(new TextEncoder().encode("GIF89a"))).toBe("image/gif");
    expect(imageType(new TextEncoder().encode("RIFF....WEBPVP8"))).toBe(
      "image/webp",
    );
  });
});
