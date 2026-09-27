import { describe, expect, test } from "bun:test";
import { promptVersions } from "@winston/db/schema";
import { inRollback, testDb } from "@winston/db/testing";
import { eq } from "drizzle-orm";
import {
  ensurePromptVersion,
  promptHash,
  promptVersion,
  systemPrompts,
  type ToolDefinition,
} from "./index.ts";

const sendMessage: ToolDefinition = {
  name: "send_message",
  description: "Send the user a Telegram message.",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
};

describe("promptHash", () => {
  test("is stable across processes", () => {
    const script = `import { promptHash } from "./src/index.ts"; console.log(promptHash("prompt", ${JSON.stringify([sendMessage])}).hash);`;
    const child = Bun.spawnSync(["bun", "-e", script], {
      cwd: `${import.meta.dir}/..`,
    });
    expect(child.stdout.toString().trim()).toBe(
      promptHash("prompt", [sendMessage]).hash,
    );
  });

  test("ignores key order inside tool schemas", () => {
    const reordered: ToolDefinition = {
      inputSchema: {
        required: ["text"],
        properties: { text: { type: "string" } },
        type: "object",
      },
      description: sendMessage.description,
      name: sendMessage.name,
    };
    expect(promptHash("prompt", [reordered]).hash).toBe(
      promptHash("prompt", [sendMessage]).hash,
    );
  });

  test("changes with the prompt text, the tools, or their order", () => {
    const other = { ...sendMessage, name: "other" };
    const hashes = [
      promptHash("prompt", [sendMessage, other]),
      promptHash("prompt.", [sendMessage, other]),
      promptHash("prompt", [sendMessage]),
      promptHash("prompt", [other, sendMessage]),
    ].map((version) => version.hash);
    expect(new Set(hashes).size).toBe(hashes.length);
  });
});

describe("systemPrompts", () => {
  test("the front-of-house prompt is loaded and names its one channel to the user", () => {
    expect(systemPrompts["front-of-house"]).toContain("send_message");
  });
});

describe("ensurePromptVersion", () => {
  test("stores a version once, keyed by its hash", async () => {
    await inRollback(await testDb(), async (tx) => {
      const version = promptVersion("front-of-house", [
        { ...sendMessage, description: crypto.randomUUID() },
      ]);
      await ensurePromptVersion(tx, version);
      await ensurePromptVersion(tx, version);
      const rows = await tx
        .select()
        .from(promptVersions)
        .where(eq(promptVersions.hash, version.hash));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        name: "front-of-house",
        content: version.content,
      });
    });
  });
});
