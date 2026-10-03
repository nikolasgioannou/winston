/**
 * A replay case (docs/design.md §6, "Replays"): one model call's context, to
 * run again with a candidate prompt or model, and the rubric its next move
 * is judged by. Production cases are the founder's data, kept in
 * `production/`, which git ignores; held-out cases (`cases/`) are written to
 * test the same causes elsewhere.
 */
import type { ToolDefinition } from "@winston/prompts";
import type { ModelMessage } from "ai";
import { z } from "zod";

export interface ReplayCase {
  name: string;
  /** The cause it tests: time, authority, conflict or commitment. */
  cause: "time" | "authority" | "conflict" | "commitment";
  source: "production" | "held-out";
  /** What a good next move does, and what fails, for the judge. */
  rubric: string;
  /** The prompt the call saw: its system prompt and tools. */
  system: string;
  tools: ToolDefinition[];
  messages: ModelMessage[];
}

export const replayCase = z.object({
  name: z.string().min(1),
  cause: z.enum(["time", "authority", "conflict", "commitment"]),
  source: z.enum(["production", "held-out"]),
  rubric: z.string().min(1),
  system: z.string(),
  tools: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      inputSchema: z.record(z.string(), z.unknown()),
    }),
  ),
  messages: z.array(z.record(z.string(), z.unknown())),
});
