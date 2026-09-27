/**
 * `bun run model:smoke`: one real call per profile through OpenRouter, twice,
 * printing usage. The second call of each should read the system prompt from
 * the cache. Costs a few cents. Not part of the test suite.
 */
import { promptHash, systemPrompts } from "@winston/prompts";
import { loadConfig } from "@winston/shared/config";
import { z } from "zod";
import { cacheBreakpoint } from "./cache.ts";
import {
  createModelGateway,
  modelProfiles,
  type ModelCallSink,
  type ModelProfile,
} from "./gateway.ts";

const { OPENROUTER_API_KEY } = loadConfig(
  z.object({ OPENROUTER_API_KEY: z.string().min(1) }),
);

// Prints each call instead of storing it.
const printCall: ModelCallSink = (call) => {
  console.log(
    `  ${call.model} via ${call.provider ?? "?"}, stop: ${call.stopReason}, ${String(call.latencyMs)} ms`,
  );
  console.log(
    `  input ${String(call.inputTokens)} (cached ${String(call.cachedTokens)}, cache write ${String(call.cacheWriteTokens)}), output ${String(call.outputTokens)} (reasoning ${String(call.reasoningTokens)}), cost $${call.costUsd?.toFixed(6) ?? "?"}`,
  );
  return Promise.resolve();
};
const gateway = createModelGateway({
  apiKey: OPENROUTER_API_KEY,
  sink: printCall,
});

// Long enough to clear Anthropic's minimum cacheable prefix on every model.
const system = [
  systemPrompts["front-of-house"],
  "# Reference (smoke test padding)",
  ...Array.from(
    { length: 120 },
    (_, i) =>
      `Note ${String(i + 1)}: this paragraph pads the system prompt so the cache has something to hold. It carries no instructions.`,
  ),
].join("\n\n");
const instructions = cacheBreakpoint({
  role: "system" as const,
  content: system,
});
// Never stored: the sink only prints.
const run = {
  runId: "run_smoke",
  userId: "usr_smoke",
  prompt: { name: "front-of-house" as const, ...promptHash(system, []) },
  contextRange: () => ({ fromMessageId: 0, toMessageId: 0 }),
};

for (const profile of Object.keys(modelProfiles) as ModelProfile[]) {
  for (const attempt of ["first", "second"]) {
    const result = await gateway.generate({
      profile,
      run,
      instructions,
      prompt: "Reply with one short sentence: what's your name?",
    });
    console.log(`${profile} (${attempt} call): ${result.text.trim()}`);
  }
}
