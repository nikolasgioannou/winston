---
id: "0bfb79"
title: Build the model gateway on the Vercel AI SDK and OpenRouter
status: done
priority: none
labels:
  - agents
  - m1
created_at: 2026-09-27T05:30:54.631Z
updated_at: 2026-09-27T20:32:20.754Z
blocked_by:
  - "2c5ac8"
  - "9378a8"
---

Every model call in Winston goes through one small module, so provider rules live in one place (docs/design.md §1 Implementation and §6).

This ticket starts with **thorough research**, because two assumptions in the design must be verified, not trusted:
- The Vercel AI SDK v7: `generateText`/`streamText`, `ToolLoopAgent` and `WorkflowAgent`, `stopWhen`, `prepareStep`, `onStepFinish`, tools without `execute`, and message types.
- `@openrouter/ai-sdk-provider`: provider routing options (pinning `order: ["anthropic"]` with no fallbacks), `providerOptions.openrouter.cacheControl`, and `reasoning.effort`.
- **Verify** that per-message effort changes and reasoning passback (`reasoning_details`) survive the AI SDK's abstraction through OpenRouter to Anthropic. If they don't, find the workaround and update §1/§6.
- **Verify** that AI SDK v7 (which targets Node 22+/ESM) runs cleanly on Bun.
- Confirm the OpenRouter gotchas from docs/research/models-openrouter.md still hold: never send `verbosity`, `temperature`/`top_p`/`top_k` or forced `tool_choice`, and handle `stop_reason: "refusal"` ourselves.

Then build `packages/shared/model` (or `apps/agents/src/model`):
- Named model profiles: `front` → Sonnet 5, `background` → Opus 5.5.
- Helpers for placing cache breakpoints (system/tools, and a rolling one at the end of the previous turn).
- Effort passed explicitly on every call.
- One normalized result type with usage broken down (input, cached, cache-write, output, reasoning), stop reason and latency.

Write a small script `bun run model:smoke` that makes one real call per profile through OpenRouter and prints usage, including a second call that should show cache reads. Keep unit tests on the pure helpers. Real calls stay out of the test suite.

## Outcome

Built in `apps/agents/src/model/`, not `packages/shared`: model profiles are Winston-specific, and only agents call models. Findings and rules are in docs/design.md §1 and §6.
- **Effort:** research showed that changing effort mid-conversation through OpenRouter invalidates the message cache; per-message effort is a Claude-API-only beta. With the user, we decided effort is **fixed per profile** (`front` → Sonnet 5 at `low`, `background` → Opus 5.5 at `high`), so `gateway.model(profile)` takes no effort argument (decision #67, plus a risk entry for event-run cost).
- **Provider rules:** the gateway wraps the OpenRouter model in middleware that rejects sampling settings and forced tool choice, and pins routing on the model itself (per-call provider options would replace it).
- **Cache breakpoints:** `cacheBreakpoint()` marks a message. The system message goes in `instructions` (AI SDK v7), and its breakpoint also covers the tools.
- **Call records:** `recordStep()` normalizes one step into what `model_calls` records, including `refusal`.
- **Smoke test:** `bun run model:smoke` passed on both profiles, with cache reads on the second calls and Anthropic serving.
- **Effort A/B:** a one-off A/B confirmed `reasoning.effort` works on Sonnet 5; Opus 5.5 was inconclusive for both knobs.
