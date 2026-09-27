/**
 * `bun run model:smoke`: one real call per profile through OpenRouter, twice,
 * printing usage. The second call of each should read the system prompt from
 * the cache. Costs a few cents. Not part of the test suite.
 */
import { systemPrompts } from "@winston/prompts";
import { loadConfig } from "@winston/shared/config";
import { generateText } from "ai";
import { z } from "zod";
import { cacheBreakpoint } from "./cache.ts";
import {
  createModelGateway,
  modelProfiles,
  type ModelProfile,
} from "./gateway.ts";
import { recordStep } from "./record.ts";

const { OPENROUTER_API_KEY } = loadConfig(
  z.object({ OPENROUTER_API_KEY: z.string().min(1) }),
);
const gateway = createModelGateway({ apiKey: OPENROUTER_API_KEY });

// Long enough to clear Anthropic's minimum cacheable prefix on every model.
const instructions = cacheBreakpoint({
  role: "system" as const,
  content: [
    systemPrompts["front-of-house"],
    "# Reference (smoke test padding)",
    ...Array.from(
      { length: 120 },
      (_, i) =>
        `Note ${String(i + 1)}: this paragraph pads the system prompt so the cache has something to hold. It carries no instructions.`,
    ),
  ].join("\n\n"),
});

for (const profile of Object.keys(modelProfiles) as ModelProfile[]) {
  for (const attempt of ["first", "second"]) {
    const result = await generateText({
      model: gateway.model(profile),
      instructions,
      prompt: "Reply with one short sentence: what's your name?",
    });
    const record = recordStep(result.finalStep);
    console.log(`${profile} (${attempt} call): ${result.text.trim()}`);
    console.log(
      `  ${record.model} via ${record.provider ?? "?"}, stop: ${record.stopReason}, ${String(record.latencyMs)} ms`,
    );
    console.log(
      `  input ${String(record.inputTokens)} (cached ${String(record.cachedTokens)}, cache write ${String(record.cacheWriteTokens)}), output ${String(record.outputTokens)} (reasoning ${String(record.reasoningTokens)}), cost $${record.costUsd?.toFixed(6) ?? "?"}`,
    );
  }
}
