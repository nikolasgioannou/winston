/**
 * The one place models are created (docs/design.md §1, §6). Everything goes
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
 */
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { wrapLanguageModel, type LanguageModel } from "ai";

/** The model (OpenRouter id) and effort for each role. */
export const modelProfiles = {
  front: { model: "anthropic/claude-sonnet-5", effort: "low" },
  background: { model: "anthropic/claude-opus-5.5", effort: "high" },
} as const;

export type ModelProfile = keyof typeof modelProfiles;

export interface ModelGatewayOptions {
  apiKey: string;
  /** For tests: a fake `fetch` so no request leaves the process. */
  fetch?: typeof fetch;
}

export function createModelGateway({ apiKey, fetch }: ModelGatewayOptions) {
  const openrouter = createOpenRouter({
    apiKey,
    ...(fetch ? { fetch } : {}),
  });

  return {
    model(profile: ModelProfile): LanguageModel {
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
