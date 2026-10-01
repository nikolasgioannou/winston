---
id: "463072"
title: Match events to subscriptions and fire them in batches
status: done
priority: none
labels:
  - agents
  - events
  - m7
created_at: 2026-09-27T05:40:24.707Z
updated_at: 2026-10-01T19:34:50.454Z
blocked_by:
  - "3f6521"
  - "6a3656"
  - "f81278"
---

The heart of proactivity: stored events are matched against active subscriptions, batched, and fired as background runs (docs/design.md §3, §17 Event pipeline steps 5–7).

Matching, for each new event:
- Active subscriptions for its type and user.
- The connection matches, if the subscription is scoped to one.
- `scope_ref` matches, if scoped (the thread or calendar event).
- The **structured filter** matches, evaluated in our code using the catalog's filter semantics.
- The **native query**, if present, is checked against the provider. For Gmail, a `messages.list` with `q = "<native> rfc822msgid:<id>"`. Do this last, since it costs an API call.
- **`self_caused` events don't fire subscriptions by default.** That's what stops Winston reacting to his own actions. Note the default in §3.

Batching:
- A match joins the trigger's pending `trigger_batch`. The first event sets `fire_at` to now + **30 s**, and a `fire_trigger_batch` job is enqueued with a dedupe key per batch.
- At `fire_at`, the batch fires: `startTriggerRun` with all of the batch's events.
- A subscription that becomes exhausted mid-batch still fires that batch once, and nothing after it.

Tests: each matching dimension, native query checking (mocked), the self-caused exclusion, five events in 10 s producing one run with five events, `max_fires: 1` firing exactly once even with a burst, and scoped subscriptions ignoring other threads.

## As built

- `matchEvents`, `fireBatch` and the `fire_trigger_batch` handler in `apps/agents/src/triggers/matching.ts`; the sync handler matches right after storing. The self-caused default is noted in docs/design.md §3 (Matching as built).
- A native-query check that fails (the provider erring) skips that subscription for that event rather than failing the sync.
- Derived timers and system events feed the same matcher in 4da088 and 0512b5.

