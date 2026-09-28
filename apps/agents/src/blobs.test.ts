import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { localBlobStore, storableMessage } from "./blobs.ts";

describe("storableMessage", () => {
  test("images in tool results go to blob storage and become a text stub", async () => {
    const dir = await mkdtemp(join(tmpdir(), "winston-blobs-"));
    const bytes = new Uint8Array(200_000).map((_, i) => i % 256);
    const data = Buffer.from(bytes).toString("base64");
    const message: ModelMessage = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "view_image",
          output: {
            type: "content",
            value: [
              { type: "text", text: "~/shot.png (800×600 PNG)" },
              {
                type: "file",
                mediaType: "image/png",
                data: { type: "data", data },
              },
            ],
          },
        },
      ],
    };
    const stored = await storableMessage(message, localBlobStore(dir));
    const json = JSON.stringify(stored);
    expect(json.length).toBeLessThan(1_000);
    const key = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    expect(json).toContain(`stored as blob ${key}`);
    expect(json).toContain("~/shot.png (800×600 PNG)");
    expect(
      new Uint8Array(await Bun.file(join(dir, key)).arrayBuffer()),
    ).toEqual(bytes);
  });

  test("other messages are stored as they are", async () => {
    const dir = await mkdtemp(join(tmpdir(), "winston-blobs-"));
    const message: ModelMessage = { role: "user", content: "hi" };
    expect(await storableMessage(message, localBlobStore(dir))).toBe(message);
  });
});
