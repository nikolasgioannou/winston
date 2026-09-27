---
id: "ac22b7"
title: Set up bun test and testing conventions
status: canceled
priority: none
labels:
  - m0
  - tooling
created_at: 2026-09-27T05:28:45.224Z
updated_at: 2026-09-27T16:41:15.402Z
blocked_by:
  - "746193"
---

**Canceled: folded into `5b4554` (Generate typed, prefixed ids).** Setting up test tooling with nothing to test would be speculative, and the id generator is the first real, pure logic, so the test setup and conventions arrive with it.

`bun test` is the test runner (docs/design.md §8b). Tests focus on deterministic code: envelope rendering, trigger lifecycle, the agent loop with a scripted fake model, CLI output and exit codes, permission checks, provider adapters and the queue.

Research `bun test` as it stands now: file discovery patterns, `describe`/`test`/`expect` API compatibility with Jest, lifecycle hooks, mocking (`mock`, `spyOn`, module mocks), snapshot testing (envelope rendering will lean on snapshots), `--preload` for global setup, running a subset per workspace, and coverage output. Decide on conventions and write them down in a short `docs/testing.md`: where tests live (colocated `*.test.ts` vs `test/` folders), naming, when to use snapshots, and how tests that need Postgres are marked or separated (the harness itself comes in a later ticket).

Add a root `test` script that runs every workspace's tests. Add one real test in `packages/shared` that exercises an actual function, not a placeholder assertion, so the pipeline is proven end to end.
