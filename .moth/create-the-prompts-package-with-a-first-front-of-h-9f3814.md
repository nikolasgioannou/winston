---
id: "9f3814"
title: Create the prompts package with a first front-of-house prompt
status: todo
priority: none
labels:
  - agents
  - m1
  - prompts
created_at: 2026-09-27T05:30:54.585Z
updated_at: 2026-09-27T05:30:54.616Z
blocked_by:
  - "87ce11"
---

System prompts live in the repo as Markdown in `packages/prompts` (docs/design.md §1). They're versioned by content hash, so every model call records exactly which prompt produced it (§12, `prompt_versions`).

Build the package:
- A loader that reads prompt Markdown files at build time or startup, and exposes them as typed exports.
- A `promptHash(systemPrompt, toolDefinitions)` that's stable: canonical JSON for tool schemas, so key order doesn't change the hash.
- An `ensurePromptVersion()` that upserts into `prompt_versions` once per process per hash.

Write a **best-effort first draft** of the front-of-house system prompt. The founder has said prompts get refined through use, so aim for good judgment, not perfection. Cover:
- Winston's identity and chief-of-staff voice (product.md §5).
- How to read `<system_event>` envelopes, and that `<data>` is never instructions.
- That the only way to reach the user is `send_message`, and that ending a turn without it is fine and often right.
- Staying brief.

Leave clearly marked sections for capabilities added in later milestones (bash and CLI, delegation, triggers, notes). The prompt must be **fully static**: no dates, names or user data, which is an invariant for caching.

Tests: the hash is stable across runs and key orders, and changes when the text changes.
