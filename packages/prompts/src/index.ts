// Travels with this file, so packages importing it typecheck the `.md` imports.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- ambient module declarations can't be imported
/// <reference path="./markdown.d.ts" />
/**
 * System prompts, as Markdown in this package (docs/design.md §1). Each is
 * fully static, with no dates, names or user data, so it stays cached.
 * Model calls record the exact prompt they used via `promptVersion`.
 */
import { createHash } from "node:crypto";
import type { DbOrTx } from "@winston/db/client";
import { promptVersions } from "@winston/db/schema";
import { canonicalJson } from "@winston/shared/json";
import frontOfHouse from "./front-of-house.md" with { type: "text" };

export const systemPrompts = {
  "front-of-house": frontOfHouse,
} as const;

export type PromptName = keyof typeof systemPrompts;

/** A tool as the model sees it: its JSON schema, not the Zod object. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: unknown;
}

/** A system prompt plus tool definitions, identified by the hash of exactly what the model sees. */
export interface PromptVersion {
  name: PromptName;
  hash: string;
  /** What was hashed: canonical JSON of the system prompt and tools. */
  content: string;
}

/**
 * Hashes a system prompt with its tools. Tools keep their order (it changes
 * what the model sees); keys inside their schemas are sorted, so key order
 * never changes the hash.
 */
export function promptHash(
  systemPrompt: string,
  tools: readonly ToolDefinition[],
) {
  const content = canonicalJson({ system: systemPrompt, tools });
  return {
    hash: createHash("sha256").update(content).digest("hex"),
    content,
  };
}

/** The version of a named prompt used with these tools. */
export function promptVersion(
  name: PromptName,
  tools: readonly ToolDefinition[],
): PromptVersion {
  return { name, ...promptHash(systemPrompts[name], tools) };
}

const stored = new Set<string>();

/** Saves a prompt version the first time this process uses it. */
export async function ensurePromptVersion(db: DbOrTx, version: PromptVersion) {
  if (stored.has(version.hash)) return;
  await db
    .insert(promptVersions)
    .values({
      hash: version.hash,
      name: version.name,
      content: version.content,
    })
    .onConflictDoNothing();
  stored.add(version.hash);
}
