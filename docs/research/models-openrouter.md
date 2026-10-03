# Research: Jev, browser-use models, OpenRouter + Anthropic

> Researched 2026-09-26. Benchmark sources disagree, so compare numbers within a single source.

## Jev (TypeSafe AI)

- Released around **2026-09-19**. TypeSafe calls it a "System One" model. **It is not a chat LLM:** it takes a state plus typed questions (choice among up to 255 options, score, true/false probability) and returns **typed decisions with calibrated probabilities**. It generates no free text.
- **$0.042 per 1M input tokens, output free. About 70–500 ms per call.** Native API is waitlisted (`api.typesafe.ai/v1/systemone`). Also on Vercel AI Gateway.
- Browser use: Browser Use's open-source "jev-ultrafast" did a Google Flights search in 7.1 s with 101 protocol calls (previously 9.45 s and 1,092). The open-source `jev-browser` project makes one Jev call per step (which element to act on, P(goal met), P(stuck)). **A separate LLM types text**, because Jev can't.
- **No standard benchmark results** (OSWorld, Mind2Web). Only vendor-run evals.
- **On OpenRouter:** only `typesafe/jev-router` (added 2026-09-25), a _router_ that picks a model and effort for each request. Jev itself isn't served there.
- **Update 2026-10-02:** OpenRouter now serves Jev itself through its decisions API (alpha): `POST https://openrouter.ai/api/alpha/decisions` with `{ model: "typesafe/jev-1.13", state, questions }`, answering `{ model, answers, usage: { input_tokens, output_tokens, cost }, provider: "TypeSafe" }`. A probe with a four-option choice and one noul took 266 ms and cost $0.0000186. (Found in `@jkudish/jev-agent-tools`, which also lists Cloudflare and Vercel AI Gateway as carriers.) Winston uses this (docs/design.md §5).
- Fit for Winston: a possible fast, cheap **action picker** inside the browser loop, alongside an LLM. It can't be the agent.

## Browser/computer-use model standings

- **OSWorld 2.0** (Steel, Sep 2026): Fable 5.1 77.9% · Simular Sai 73.0% · GPT-6 Astra 72.6% · Opus 5 70.6% · Muse Spark 1.3 66.9%.
- **Opus 5.5** (released 2026-09-22): Anthropic reports 81.8% partial pass and 48.7% strict completion on OSWorld 2.0, against Fable 5.1 80.7% and Opus 5 74.0% on the same basis. No independent results on the same harness yet.
- Gemini 3.8 Flash 59.0% (OSWorld 2.0). Sonnet 5 81.2% (OSWorld-Verified, the older benchmark).
- **Takeaway:** Opus 5.5 ($4/$20) and Fable 5.1 ($10/$50) lead. Opus 5.5 is the best value at the top.

## OpenRouter pricing (per 1M tokens)

| Model     | Input | Output | Cache read | Write 5m | Write 1h |
| --------- | ----- | ------ | ---------- | -------- | -------- |
| Sonnet 5  | $2    | $10    | $0.20      | $2.50    | $4       |
| Opus 5.5  | $4    | $20    | $0.20      | $5       | $8       |
| Opus 5    | $5    | $25    | $0.50      | $6.25    | $10      |
| Fable 5.1 | $10   | $50    | $0.25      | $12.50   | $20      |
| Haiku 4.5 | $1    | $5     | $0.10      | $1.25    | $2       |

## OpenRouter + Anthropic: what works and gotchas

- ✅ **Prompt caching:** `cache_control`, 5-min and 1-h TTLs. **Sticky routing lasts only 10 min**, so pin the provider (Anthropic) to keep caches warm for agents that pause.
  - **The 1-hour TTL, verified (2026-10-03):** `providerOptions.openrouter.cacheControl: { type: "ephemeral", ttl: "1h" }` passes through `@openrouter/ai-sdk-provider` 3.1.0. A 13,202-token write on Sonnet 5 cost $0.052876, the 1-hour rate ($4/M), so the open provider issue (#196) about 1-hour writes billed at the 5-minute rate doesn't apply here. The same prompt sent 11½ minutes later read all 13,202 tokens from the cache ($0.0027). OpenRouter reports cache writes without their lifetime.
- ✅ **Effort** via `reasoning.effort` / `output_config.effort`. ⚠️ `verbosity` overrides it if both are set, so never send `verbosity`. Opus 5.5 defaults to _medium_ and always thinks.
- ✅ Beta headers are forwarded or added automatically. Per-message effort works (not on raw Bedrock routes). Mid-conversation system messages work.
- ✅ Function tools work.
- ❌ **Forced `tool_choice`** (any or a named tool) fails on Opus 5.5.
- ❌ **Native computer-use tool rejected** for Opus 5/5.5. This doesn't affect us, because we use our own function tools.
- ❌ **Anthropic's server-side refusal fallback isn't used.** OpenRouter's own fallback array may not trigger on a 200 `refusal`. **Handle `stop_reason: "refusal"` in our own code.**
- ❌ Don't send `temperature` / `top_p` / `top_k` to Opus 5.5.
- Latency overhead: about 25–60 ms.

## Fast chat latency (third-party figures)

- Sonnet 5, low effort: time to first token about 1.0–1.6 s (p95 about 9 s), 65–231 tok/s. Accepts `thinking: disabled`.
- Haiku 4.5: time to first token about 0.6 s.
- Gemini 3.x Flash with reasoning off: fastest and cheapest overall.
- High reasoning effort adds 5–30x latency, so keep effort low or off for the front of house.

## Sources

- https://www.marktechpost.com/2026/09/19/typesafe-ai-releases-jev/ · https://pythonlibraries.substack.com/p/browser-use-puts-the-jev-model-into · https://github.com/jkudish/jev-browser
- https://leaderboard.steel.dev/leaderboards/osworld-2/ · https://llm-stats.com/benchmarks/osworld-verified · https://llm-stats.com/blog/research/claude-opus-5-5-launch · https://www.vellum.ai/blog/gemini-3-8-flash-benchmarks-explained
- https://openrouter.ai/docs/guides/best-practices/prompt-caching · https://openrouter.ai/docs/cookbook/evaluate-and-optimize/model-migrations/opus-5-5 · https://openrouter.ai/docs/guides/routing/model-fallbacks · https://openrouter.ai/docs/guides/features/tool-calling
- https://github.com/NousResearch/hermes-agent/issues/43432 · https://github.com/openclaw/openclaw/issues/98976
- https://artificialanalysis.ai/models/claude-sonnet-5-low · https://llmlatency.dev/provider/openrouter
