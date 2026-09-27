---
id: "0bfb79"
title: Build the model gateway on the Vercel AI SDK and OpenRouter
status: todo
priority: none
labels:
  - agents
  - m1
created_at: 2026-09-27T05:30:54.631Z
updated_at: 2026-09-27T17:32:16.376Z
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
