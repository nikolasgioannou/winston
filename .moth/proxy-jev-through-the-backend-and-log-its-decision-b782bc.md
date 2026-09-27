---
id: "b782bc"
title: Proxy Jev through the backend and log its decisions (with the founder for
  access)
status: todo
priority: none
labels:
  - backend
  - browser
  - collab
  - m8
created_at: 2026-09-27T05:42:04.100Z
updated_at: 2026-09-27T05:42:04.136Z
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
