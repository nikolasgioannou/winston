---
id: "3f95f4"
title: Handle model failures and refusals in the front of house
status: done
priority: none
labels:
  - agents
  - m1
created_at: 2026-09-27T05:30:55.164Z
updated_at: 2026-09-27T22:42:14.592Z
blocked_by:
  - "36a9c9"
  - "cb9674"
---

The user is waiting on the front of house, so failures must degrade quickly and honestly (docs/design.md §6, Failure handling, kept deliberately simple).

Front-of-house policy:
- On a transient error (429, 5xx, timeout, connection reset), make **2 quick retries**.
- If those fail, make **one attempt on Opus 5.5** as the fallback model. This loses the cache for that turn, which is acceptable.
- If that fails too, the backend sends a **fixed message**, something like "I'm having trouble thinking right now; I'll reply as soon as I'm back." It's a plain string with no model involved. The user's inbound items stay unconsumed, so the next successful turn answers them.
- **Refusals** (`stop_reason: "refusal"`, which OpenRouter doesn't fall back from on its own) are retried once on the fallback model. If refused again, the turn continues without that output, and Winston says he couldn't help with that.

Make sure every attempt, including failed ones, is recorded in `model_calls`. Avoid spamming the fixed message: during an outage lasting several turns, send it at most once until a turn succeeds.

Tests with a fake transport: retry counts, fallback switching, the fixed message and its suppression, refusal handling, and items remaining unconsumed after total failure.

Also fix a queue gap found while serializing turns: `fail()` requeues a job with its dedupe key, which violates the partial unique index `jobs_queued_dedupe_key` if a newer job with the same key is already queued (for example a failed `front_turn` while the user's next message is queued). Today the failure isn't recorded and the job is only retried when its lease expires. Decide, for example, to drop the dedupe key on requeue or to complete the failed job when a queued sibling exists, and test it.

## Outcome

Built as described in docs/design.md §6 (Failure handling, the Implementation notes under front of house and refusals).
- **Input on failure:** input is claimed at turn start (exactly-once), so "input stays unconsumed" became "a failed turn releases its input". The window now loads only completed runs, so released input appears once. The same rule gives crash recovery: a dead `running` run found while holding the lock is failed and its input released.
- **Fallback profile:** a new `frontFallback` profile (Opus 5.5, `low`) keeps effort fixed per profile.
- **Recorded retries:** the AI SDK's internal retries are off, so each attempt is recorded. The gateway records failed calls as `error` and takes a `stepOffset`, which also fixes step numbers in the per-step loop (all calls were recorded as step 0 since the steering ticket).
- **Queue fix:** `fail()` drops a requeued job's dedupe key when a queued sibling holds it, instead of violating the unique index.
- **Prompt-version fix:** `ensurePromptVersion` lost its in-memory cache and now runs in the model-call transaction. The cache went wrong whenever the inserting transaction rolled back (surfaced three times in tests).
- **Mutation checks:** removing the input release, or the notice suppression, fails the tests.
