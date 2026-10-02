---
id: "b782bc"
title: Proxy Jev through the backend and log its decisions
status: done
priority: none
labels:
  - backend
  - browser
  - collab
  - m8
created_at: 2026-09-27T05:42:04.100Z
updated_at: 2026-10-02T16:36:02.299Z
blocked_by:
  - "480aff"
---

Jev (TypeSafe AI) is a fast, cheap decision model that returns typed answers with calibrated probabilities. It's used as a confidence-gated action picker in the browser loop (docs/design.md §5 Browser, §6; docs/research/models-openrouter.md). The API is **waitlisted**, so check with the founder that access has been granted, and get the key into Secrets Manager and `.env.local`.

Research the Jev API from TypeSafe's docs: `POST /v1/systemone`, question types (choice among up to 255 options, score, true/false probability), how state is passed, limits, latency and pricing. Look at the open-source `jev-browser` project and Browser Use's `jev-ultrafast` for how they frame browser questions.

Build:
- A VM API route (for example `POST /v1/jev/decide`) that forwards a request to TypeSafe with the backend-held key. **The key never touches the VM** (§15).
- A `jev_decisions` row per call: the question, the answer, latency, and later the action taken and outcome. Record the cost in `cost_ledger` with category `jev`.
- Timeouts and failures return a clear error, and the caller falls back to Opus. Jev is always optional.

Tests: request forwarding with a mocked TypeSafe API, decision logging, and failure paths.

## As built

- **No waitlist:** OpenRouter now serves Jev through its decisions API (alpha, `POST https://openrouter.ai/api/alpha/decisions`, model `typesafe/jev-1.13`), with the same `{ state, questions }` body as TypeSafe's own API. Found in `@jkudish/jev-agent-tools` (the client `jev-browser` uses) and checked with one probe on the dev key: 266 ms, $0.0000186, the right pick. So the founder-access step went away: the gateway gets the existing `openrouter-api-key` secret, and the title lost "(with the founder for access)".
- `POST /v1/jev/decide` in `packages/vm-api/src/jev.ts`: validates (1–8 questions; choice 2–255 options; state ≤ 64 KB), forwards with a 5 s timeout, logs every call to `jev_decisions` (new table, `jev_` ids) with the answer or the error, and charges OpenRouter's reported cost to `cost_ledger` as `jev` (new enum value). Failures, incomplete answers and a missing key return `503 unavailable` with "Drive the page yourself".
- The action and outcome columns are there for autopilot (91faf5) to fill in.
- Tests with a fake OpenRouter: forwarding (URL, key, body), logging and cost, failure and incomplete answers logged without charge, no key, too many options.
