---
id: "35fdd4"
title: Add connection storage with encrypted tokens
status: todo
priority: none
labels:
  - backend
  - db
  - m3
created_at: 2026-09-27T05:34:40.879Z
updated_at: 2026-09-27T05:34:40.912Z
blocked_by:
  - "762cf0"
---

Connected accounts hold Google refresh tokens, which are the most sensitive data in the system. They're encrypted at rest with KMS in production, and only `api` and `agents` can decrypt (docs/design.md §12a, §13).

Add the `connections` table (§14):
- Domain and provider.
- `external_email`, `alias`, `scopes`.
- `capabilities` as a jsonb toggle map.
- `token_ciphertext`, `granted_at`, `status`.
- `sync_state` (for M7), `watch_expires_at`.

Constraint: one connection per (user, domain, external_email).

Build a small **token vault** interface (`encrypt(plaintext) → ciphertext`, `decrypt(ciphertext) → plaintext`) with two implementations:
- **Local:** AES-GCM with a key from `.env.local`.
- **KMS envelope encryption:** its implementation lands in M4. Define the interface now so nothing changes later.

Research AWS KMS envelope encryption (data keys via `GenerateDataKey`, caching data keys sensibly), so the interface fits it naturally.

Also define DTO helpers for connections now. Server functions must never return `token_ciphertext` (the explicit-DTO invariant, §7). Add a test that serializing a connection DTO can't include it.

Tests: encrypt/decrypt round trip, tampered ciphertext rejected, the uniqueness constraint, and the DTO excluding secrets.
