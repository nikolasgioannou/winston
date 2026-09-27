import type { StepResult, ToolSet } from "ai";
import { z } from "zod";

/** One model call, normalized: what `model_calls` records. */
export interface ModelCallRecord {
  model: string;
  /** The upstream provider OpenRouter used, when it says. */
  provider: string | undefined;
  /** All input tokens, cached or not. */
  inputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  /** All output tokens, reasoning included. */
  outputTokens: number;
  reasoningTokens: number;
  /** OpenRouter's billed cost, when it reports one. */
  costUsd: number | undefined;
  /** The AI SDK's finish reason, or `refusal`, or the raw reason when it's `other`. */
  stopReason: string;
  latencyMs: number;
}

const openrouterMetadata = z.object({
  provider: z.string().optional(),
  usage: z.object({ cost: z.number().optional() }).optional(),
});

export function recordStep(step: StepResult<ToolSet>): ModelCallRecord {
  const { usage } = step;
  const metadata = openrouterMetadata.safeParse(
    step.providerMetadata?.openrouter,
  );
  return {
    model: step.response.modelId,
    provider: metadata.data?.provider,
    inputTokens: usage.inputTokens ?? 0,
    cachedTokens: usage.inputTokenDetails.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.inputTokenDetails.cacheWriteTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    reasoningTokens: usage.outputTokenDetails.reasoningTokens ?? 0,
    costUsd: metadata.data?.usage?.cost,
    stopReason: stopReason(step),
    latencyMs: Math.round(step.performance.stepTimeMs),
  };
}

// Anthropic's `refusal` isn't one of the AI SDK's finish reasons, so it
// arrives as `other` with the raw reason alongside.
function stopReason(step: StepResult<ToolSet>) {
  if (step.rawFinishReason === "refusal") return "refusal";
  if (step.finishReason === "other") return step.rawFinishReason ?? "other";
  return step.finishReason;
}
