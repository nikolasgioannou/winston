---
id: "35fdd4"
title: Add connection storage with encrypted tokens
status: done
priority: none
labels:
  - backend
  - db
  - m3
created_at: 2026-09-27T05:34:40.879Z
updated_at: 2026-09-30T03:32:44.951Z
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

## Outcome

- `connections` table as §14 describes (`acct_` ids), with enums for domain, provider and status, `capabilities` as a typed jsonb map, and a unique constraint on (user, domain, external email), which also serves lookups by user. The vocabulary (domains, providers, each domain's capabilities, statuses) is in `@winston/domain/connections`.
- Token vault (`@winston/shared/token-vault`): async `encrypt`/`decrypt` taking a non-secret context that must match (KMS encryption context and GCM additional data, so a ciphertext only opens for its row), and scheme-tagged ciphertexts. The local vault is AES-256-GCM with a pinned 16-byte tag and `TOKEN_ENCRYPTION_KEY`, which `setup.sh` now generates.
- KMS research (AWS's `GenerateDataKey` and data key caching docs): a fresh data key per encryption, sealed locally, with the encrypted key stored alongside; caching only if volume demands it, so none on encrypt. Written up in design.md §13 for the M4 implementation.
- DTOs: `toConnectionDto` builds the shape field by field and `connectionDtoColumns` selects only its columns, so neither the token nor sync state can leave.
- Tests: round trip with fresh IVs; tampered bytes, a truncated tag, the wrong context, key or scheme all rejected; bad keys refused; the uniqueness constraint; and DTOs (from a whole row or a narrow select) never containing the token.

