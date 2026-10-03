---
id: "93c46b"
title: Cut the front of house's cost and latency
status: done
priority: none
labels:
  - agents
created_at: 2026-10-03T17:26:02.974Z
updated_at: 2026-10-03T18:44:52.765Z
---

From the production trace review (5c3cdf, 2026-10-03): 294 model calls cost $9.82 over about 40 hours, and the front of house was $9.43 of it.

## 1. Cache misses after pauses are about half of all spend

The front of house's context runs to 100–150k tokens, and prompt caching uses Anthropic's default 5-minute lifetime. So the first message after any pause longer than 5 minutes re-writes the whole cache, at $0.23–0.33 a turn. In the trace, 21 turns did that, for $4.89. One was "Thanks!", which cost $0.20 just to end the turn. Of the 22 pauses longer than 5 minutes, 15 were between 5 and 60 minutes, 3 were 1–3 hours and 4 were longer.

**Fix: a 1-hour cache for the front of house.**
- **Anthropic's 1h lifetime** (`cache_control: { type: "ephemeral", ttl: "1h" }`, no beta header) writes at 2× base input (Sonnet 5: $4/M, against $2.50/M for 5-minute writes), with the same $0.20/M reads. Every read refreshes it.
- **OpenRouter passes `ttl` through** to Anthropic, Bedrock and Vertex, and lists a separate `input_cache_write_1h` price.
- **`@openrouter/ai-sdk-provider` 3.1.0 forwards `providerOptions.openrouter.cacheControl` unchanged.** Anthropic docs name this exact case, a long chat where the user may not reply within 5 minutes, as the use for 1h.
- **Estimate for the trace's pattern:** each 5–60 minute pause becomes a read (about $0.02–0.03) instead of a rewrite. Pauses over an hour cost about $0.15 more, and every other write costs 60% more. Net saving is roughly $2–3 of the $9.82, about 20–25%. Background runs (Opus 5.5) stay at 5 minutes unless `model_calls` show misses between their steps.

**Changes:**
- `apps/agents/src/model/cache.ts` takes a TTL.
- The front of house uses 1h on *both* its markers (the static one on the system prompt and the rolling one), since Anthropic requires longer-lived markers before shorter ones: `front/turn.ts`, each step and the delegate brief.
- `pricing.ts` gains the 1h write rates (Sonnet 5 $4, Opus 5.5 $8) and picks by the request's lifetime. OpenRouter reports writes without splitting them by lifetime, so otherwise the 5% drift warning (`log.ts`) fires on every large write.
- Update the tests that match the exact `cache_control` (`model/gateway.test.ts`, `front/turn.test.ts`) and design §1, §12, §14.
- **Verify first (a few cents):** an open provider issue (#196) reported 1h writes through OpenRouter billed at the 5-minute rate. Send `ttl: "1h"` on a ~5k-token prefix through the smoke script, check `usage.cost` implies about $4/M on `cache_write_tokens`, then resend after 10–15 minutes and expect a full cache hit.

## 2. The window carries old browser output

Browser snapshots, `eval` page text and screenshots stay in the front of house's window until it trims at 150k (down to 100k). Every later step re-reads them, at about $0.025 per step at 125k. Stub tool results older than the last few turns: keep the call and a one-line summary, and drop the bulk ("[page text trimmed; run it again if you need it]"). Do it only at the existing trim boundary, so the cached prefix doesn't move on every step. Measure the window size and per-turn cost before and after on replayed contexts.

## 3. Slow calls, and a timeout that didn't stop them

- **What happened:** in one turn (the site check, 18:58–19:03 UTC on Oct 2), four Sonnet 5 calls took 64–123 s each, with about 85k tokens in and about 100 out, all served by Anthropic. The turn took about 7 minutes.
- **What it means:** that looks like provider-side slowness. But the front of house sets a 90-second total timeout per call (`frontCallTimeoutMs`, `timeout: 90_000` passed to `generateText`), and two calls ran past it. So the abort isn't reaching the OpenRouter request, or the recorded latency includes something else.
- **Fix:**
  - find out which, and make the timeout real so the existing transient-failure policy (retry, then fall back) kicks in;
  - consider letting OpenRouter fall back across Claude providers (Anthropic, Bedrock, Vertex) for the front of house. A fallback starts with a cold cache, which is acceptable when the alternative is a two-minute wait.

## 4. Check: too many cache markers with parallel tool calls

A cache marker on a tool message is copied onto every tool result in it. Parallel tool calls share one message (`toolMessage` in `background/run.ts`, the AI SDK's `responseMessages`), so four or more parallel calls plus the system marker could send five or more markers, over Anthropic's limit of four. Write a fake-fetch test that shows what's actually sent, and fix it if so.

Docs: §1 (prompt caching), §6 (failure handling, timeouts), §14 (`model_calls` cost), docs/research/models-openrouter.md.

Tests: 1h markers on the front of house's requests, in valid order; pricing by lifetime; old tool results stubbed only at the trim boundary; a call past the timeout is aborted and retried; marker count within limits with five parallel tool results.

## As built

**1. A 1-hour cache.**
- **Verified first:** a live call through OpenRouter showed 1-hour writes billed at the 1-hour rate (13,202 tokens, $0.052876 = $4/M), so issue #196 doesn't apply. The same prompt sent 11½ minutes later read all 13,202 tokens from the cache.
- **Where:** `cacheTtl` on the model profiles (`front` and `frontFallback` "1h", `background` "5m"); `cacheBreakpoint`/`withRollingBreakpoint` take it, and `front/turn.ts` uses it on both markers (each step and the delegate brief).
- **Pricing:** `pricing.ts` has the 1-hour write rates (Sonnet 5 $4, Opus 5.5 $8) and `log.ts` picks by the profile's lifetime, so the drift warning stays quiet.

**2. A lighter window, changed only when that's free.**
- **Stubbing only at trims would have saved nothing.** Replaying the production stream (sizes only) showed why: the window still runs between 100k and 150k, just holding different things.
- **So old tool output is shortened when the cache is cold anyway:** no front call for an hour, the cache's lifetime. It also happens at a trim, before any turn drops.
  - Output over 1,500 characters from before the latest finished turn keeps its first 400 characters and a note to run it again.
  - In the replay this cut the average context by about 20% and input cost by about 24%.
  - The boundary is `front_state.stub_before_message_id`. Each `model_calls` row records it (`context_stub_before_message_id`), so replays (ea2e27) can rebuild the exact request.

**3. The slow calls weren't slow model calls.**
- **The model calls took 3–4 s.** In the 2026-10-02 turn, each step's interim text reached Telegram 3–4 s after the step began. The rest of each step was its tools, which `latency_ms` included (the AI SDK's `stepTimeMs`).
- **The tools were waiting on the VM update hold.** A deploy had just published 0.1.194, so the gateway held every command for up to 60 s until the VM reported the new CLI. Winstond only reported it when it restarted, and it restarts only when idle (and it keeps results for 5 minutes). So all eight commands in those six minutes waited the full 60 s, then ran on the CLI that was already new. One `exec` per bash call gave 60 s; `view_image`'s two gave 120 s.
- **Fixes:**
  - **winstond** says `hello` as soon as the CLI is swapped, without confirming its own pending update. That keeps the rollback marker until a new winstond connects.
  - **The gateway** holds a VM's work at most once per version.
  - **`latency_ms`** now records the model's own time (`responseTimeMs`).
  - **The 90 s timeout** was fine. A test shows a call that never answers is cut off and retried.
- **Not done:** OpenRouter fallback across Claude providers. It was only worth it for slow model calls, and there weren't any.

**4. Too many cache markers: real, latent, fixed.**
- **The problem:** five parallel tool results sent six `cache_control` markers, over Anthropic's four. No production step had made more than two parallel calls yet.
- **The fix:** a tool message's marker now goes on its last result only. The provider uses a part's marker when the message has none.
