import type { DbOrTx } from "@winston/db/client";
import { costLedger, modelCalls } from "@winston/db/schema";
import { ensurePromptVersion } from "@winston/prompts";
import type { Logger } from "@winston/shared/logger";
import {
  modelProfiles,
  type ModelCall,
  type ModelCallSink,
} from "./gateway.ts";
import { computeCostUsd } from "./pricing.ts";

/** Reported and computed costs further apart than this suggest stale prices. */
const costDriftTolerance = 0.05;

/**
 * Records each model call as a `model_calls` row plus a `cost_ledger` row, in
 * one transaction (docs/design.md §12). A database failure is logged with the
 * full record, so nothing is lost, and never fails the turn.
 */
export function dbModelCallSink(db: DbOrTx, logger: Logger): ModelCallSink {
  return async (call) => {
    const costUsd = resolveCost(call, logger);
    if (call.stopReason !== "error" && call.provider !== "Anthropic")
      logger.warn(
        { runId: call.run.runId, provider: call.provider },
        "model call not served by Anthropic despite pinning",
      );
    try {
      await db.transaction(async (tx) => {
        await ensurePromptVersion(tx, call.run.prompt);
        await tx.insert(modelCalls).values({
          runId: call.run.runId,
          step: call.step,
          model: call.model,
          provider: call.provider ?? "unknown",
          promptHash: call.run.prompt.hash,
          contextFromMessageId: call.contextFromMessageId,
          contextToMessageId: call.contextToMessageId,
          contextStubBeforeMessageId: call.contextStubBeforeMessageId,
          inputTokens: call.inputTokens,
          cachedTokens: call.cachedTokens,
          cacheWriteTokens: call.cacheWriteTokens,
          outputTokens: call.outputTokens,
          reasoningTokens: call.reasoningTokens,
          costUsd: costUsd.toFixed(6),
          latencyMs: call.latencyMs,
          stopReason: call.stopReason,
        });
        await tx.insert(costLedger).values({
          userId: call.run.userId,
          runId: call.run.runId,
          category: "model",
          costUsd: costUsd.toFixed(6),
        });
      });
    } catch (error) {
      const { run, ...record } = call;
      logger.error(
        {
          err: error,
          runId: run.runId,
          userId: run.userId,
          promptHash: run.prompt.hash,
          record,
          costUsd,
        },
        "recording a model call failed",
      );
    }
  };
}

/** OpenRouter's charge when it reports one, otherwise computed from the price table. */
function resolveCost(call: ModelCall, logger: Logger) {
  const profile = modelProfiles[call.profile];
  const computed = computeCostUsd(profile.model, call, profile.cacheTtl);
  if (call.costUsd === undefined) return computed;
  const drift =
    Math.abs(call.costUsd - computed) / Math.max(call.costUsd, 1e-9);
  if (drift > costDriftTolerance)
    logger.warn(
      { model: call.model, reported: call.costUsd, computed },
      "reported cost differs from the price table; update pricing.ts",
    );
  return call.costUsd;
}
