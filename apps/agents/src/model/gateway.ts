/**
 * The one place models are called (docs/design.md §1, §6). Everything goes
 * through OpenRouter pinned to Anthropic, and the provider's rules live here:
 *
 * - Routing is set on the model only. Per-call `providerOptions.openrouter`
 *   is copied shallowly into the request, so a per-call `provider` would
 *   replace this one, fallbacks setting included.
 * - Effort is fixed per profile and always sent explicitly (Opus defaults to
 *   medium), through the provider's `reasoning` setting; the AI SDK's
 *   top-level `reasoning` option is ignored by this provider. It never changes
 *   mid-conversation: through OpenRouter that invalidates the message cache.
 * - Sampling settings and forced tool choice are rejected: Anthropic's
 *   thinking models return 400 for them.
 * - Every call is recorded: `generate` hands each step to the log sink
 *   before the caller's own `onStepEnd` runs, and records a failed call as
 *   `error`. The AI SDK's own retries are off (`maxRetries: 0`), since they'd
 *   hide attempts; callers retry, and each attempt is recorded.
 */
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { PromptVersion } from "@winston/prompts";
import {
  generateText,
  wrapLanguageModel,
  type LanguageModel,
  type StepResult,
  type ToolSet,
} from "ai";
import { recordStep, type ModelCallRecord } from "./record.ts";

/** The model (OpenRouter id) and effort for each role. */
export const modelProfiles = {
  front: { model: "anthropic/claude-sonnet-5", effort: "low" },
  /** Where the front of house falls back when Sonnet keeps failing or refuses (§6). */
  frontFallback: { model: "anthropic/claude-opus-5.5", effort: "low" },
  background: { model: "anthropic/claude-opus-5.5", effort: "high" },
} as const;

export type ModelProfile = keyof typeof modelProfiles;

/** The run a model call belongs to. */
export interface ModelRun {
  runId: string;
  userId: string;
  prompt: PromptVersion;
  /**
   * The stored `run_messages` ids that make up the context of the call about
   * to be recorded. Read before the caller's `onStepEnd` stores the step.
   */
  contextRange: () => { fromMessageId: number; toMessageId: number };
}

/** One recorded model call. */
export interface ModelCall extends ModelCallRecord {
  run: ModelRun;
  profile: ModelProfile;
  step: number;
  contextFromMessageId: number;
  contextToMessageId: number;
}

/** Where model calls are recorded. Must not throw: a failed log can't fail a turn. */
export type ModelCallSink = (call: ModelCall) => Promise<void>;

export interface ModelGatewayOptions {
  apiKey: string;
  sink: ModelCallSink;
  /** For tests: a fake `fetch` so no request leaves the process. */
  fetch?: typeof fetch;
}

type GenerateTextOptions<Tools extends ToolSet> = Parameters<
  typeof generateText<Tools>
>[0];

// Distributes over the union of prompt shapes (`prompt` or `messages`), which
// a plain Omit would flatten.
type OmitModel<Options> = Options extends unknown
  ? Omit<Options, "model">
  : never;

export type GenerateOptions<Tools extends ToolSet> = OmitModel<
  GenerateTextOptions<Tools>
> & {
  profile: ModelProfile;
  run: ModelRun;
  /** Added to the recorded step numbers, for callers that run one step per call. */
  stepOffset?: number;
};

export function createModelGateway({
  apiKey,
  sink,
  fetch,
}: ModelGatewayOptions) {
  const openrouter = createOpenRouter({
    apiKey,
    ...(fetch ? { fetch } : {}),
  });

  function model(profile: ModelProfile): LanguageModel {
    const { model, effort } = modelProfiles[profile];
    return wrapLanguageModel({
      model: openrouter(model, {
        provider: { order: ["anthropic"], allow_fallbacks: false },
        reasoning: { effort },
        usage: { include: true },
      }),
      middleware: {
        specificationVersion: "v4",
        transformParams: ({ params }) => {
          rejectUnsupported(params);
          return Promise.resolve(params);
        },
      },
    });
  }

  return {
    /** `generateText` on a profile's model, with every step recorded. */
    async generate<Tools extends ToolSet>({
      profile,
      run,
      stepOffset = 0,
      ...options
    }: GenerateOptions<Tools>) {
      const callerOnStepEnd = options.onStepEnd;
      let recordedSteps = 0;
      const started = performance.now();
      try {
        return await generateText<Tools>({
          ...options,
          maxRetries: 0,
          model: model(profile),
          onStepEnd: async (step: StepResult<Tools>) => {
            const { fromMessageId, toMessageId } = run.contextRange();
            await sink({
              ...recordStep(step),
              run,
              profile,
              step: stepOffset + step.stepNumber,
              contextFromMessageId: fromMessageId,
              contextToMessageId: toMessageId,
            });
            recordedSteps += 1;
            await callerOnStepEnd?.(step);
          },
        } as unknown as GenerateTextOptions<Tools>);
      } catch (error) {
        const { fromMessageId, toMessageId } = run.contextRange();
        await sink({
          model: modelProfiles[profile].model,
          provider: undefined,
          inputTokens: 0,
          cachedTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          costUsd: 0,
          stopReason: "error",
          latencyMs: Math.round(performance.now() - started),
          run,
          profile,
          step: stepOffset + recordedSteps,
          contextFromMessageId: fromMessageId,
          contextToMessageId: toMessageId,
        });
        throw error;
      }
    },
  };
}

export type ModelGateway = ReturnType<typeof createModelGateway>;

function rejectUnsupported(params: {
  temperature?: number | undefined;
  topP?: number | undefined;
  topK?: number | undefined;
  toolChoice?: { type: string } | undefined;
}) {
  for (const setting of ["temperature", "topP", "topK"] as const)
    if (params[setting] !== undefined)
      throw new Error(
        `Don't set ${setting}: Anthropic's thinking models reject sampling settings.`,
      );
  const choice = params.toolChoice?.type;
  if (choice === "required" || choice === "tool")
    throw new Error(
      "Don't force a tool choice: Anthropic's thinking models reject it. Use auto and check the result.",
    );
}
