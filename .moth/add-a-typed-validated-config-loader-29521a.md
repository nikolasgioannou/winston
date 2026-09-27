---
id: "29521a"
title: Add a typed, validated config loader
status: todo
priority: none
labels:
  - backend
  - m0
  - tooling
created_at: 2026-09-27T05:28:45.376Z
updated_at: 2026-09-27T05:28:45.421Z
blocked_by:
  - "746193"
  - "ac22b7"
---

Every service reads its settings from environment variables, validated at startup with Zod. A service with missing or invalid config must refuse to start and say exactly what's wrong (docs/design.md §12a).

Research Zod's current major version (API changes matter: error formatting, `z.coerce`, `z.url()`, etc.) and how Bun loads `.env` files natively, including precedence between `.env`, `.env.local` and the real environment. We want `.env.local` for dev secrets without extra dependencies if Bun covers it.

Build it in `packages/shared` (for example `src/config/`):
- A small helper that takes a Zod schema and `process.env`, and returns a fully typed, frozen config object or throws with a readable list of every problem at once, not just the first.
- Per-service schemas composed from shared pieces (database URL, log level, environment name `local`/`production`), so each service declares only what it needs. That also matches the per-service secret injection planned for production.
- Secrets must never appear in error messages or logs. Report *which* key is wrong, not its value.

Tests: valid env produces typed config; missing and malformed values produce one combined, readable error; secret values never appear in the error text. Keep `.env.example` in sync with every variable introduced.
