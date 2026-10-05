---
id: "74641a"
title: Connections treat every provider but Winston's mailbox as Google
status: done
priority: none
labels:
  - backend
  - connectors
  - db
parent: "80fcf0"
created_at: 2026-10-05T23:00:51.799Z
updated_at: 2026-10-05T23:34:34.175Z
---

A third provider would break in ways that compile cleanly (research doc, "What changes in Winston"):

- `googleBacked` (`packages/db/src/connections.ts`) means "not `winston`", so a new provider's connections would be swept to `expiring` after 6 days, get a `sync_connection` job every 10 minutes (which runs calendar sync for any domain that isn't mail), refresh against Google's token endpoint, and get a Gmail watch queued by `saveConnection`.
- `connectionFacts.domain` in `@winston/domain/events` is `z.enum(["mail", "calendar"])`, so `system.app.connected` for any other domain throws inside `saveConnection`'s transaction, and connecting fails.
- Revoking (`apps/agents/src/connections/revoke.ts`) and account deletion call Google's revoke endpoint for every connection, and the "another connection shares this grant" check matches on email across providers.
- Two-way branches with no exhaustiveness check: `home.server.ts`, `providers.tsx` (`ProviderIcon`), CLI `accounts.ts`, vm-api `triggers.ts` (`--account` only for mail and calendar), `watch.ts`, `db/src/testing.ts`.
- Capability copy is keyed by bare name (`describe` in vm-api `connections.ts`, `capabilityCopy` on the site), so a domain can't have its own wording.
- `requireCapability`'s messages and the reconnect links say Google and build `/auth/google/connect` URLs.

**What to build**

- A per-provider description in `@winston/connectors` (or `@winston/domain`): whether it syncs and watches, how its grant expires (Google's fixed 7 days, or the expiry the token response gave, or none), how it refreshes and revokes, and its reconnect URL. Google's two providers and `winston` fill it in today's behaviour; `googleBacked` becomes "uses Google".
- Event payloads take any connection domain (from `connectionDomains`).
- The branches above are exhaustive (`switch` with `never`, or records keyed by domain or provider), so adding `ramp` turns every gap into a compile error.
- Capability copy keyed by domain and capability.
- Revoke dispatches by provider; the sibling check only looks at connections sharing the same grant.

**No behaviour changes for Gmail, Calendar or Winston's mailbox.** This lands before `ramp` exists.

**Done when**

- [x] Existing tests pass unchanged, and new tests show that a provider which neither syncs nor expires is never swept, synced, watched or refreshed through Google
- [x] Adding a domain to `connectionDomains` fails to compile until every per-domain place handles it
- [x] `design.md` §5 (Connections & credentials, Access control) describes the per-provider description


## As built

- **`providerTraits`** in `@winston/domain/connections`, not `@winston/connectors`: the site, CLI and db need it too, and it's data. Each provider has an `issuer` (`google`, or `null` for Winston's mailbox) and `syncs`. Derived from it: `providersIssuedBy`, `syncedProviders`, `issuerOf` ("Google"), `connectPath(domain)`, `reconnectPath(connection)`. How a token refreshes and when a grant expires stay with Google's code (`googleAccessTokens`, the sweep's 7 days), selected by issuer, since Google is the only issuer; 52bf55 adds the rotating kind.
- **`googleBacked` is gone**, split by what each caller meant: `userConnected` (not Winston's mailbox) for the site's list and count, toggles, disconnecting and `accounts connect`; `synced` for reconciliation and watch renewal; `issuedBy("google")` for the grant sweep. `saveConnection` queues a watch only for a synced provider.
- **Exhaustive by construction:** the sync and watch handlers and `watchStopper` switch on the provider (lint's `switch-exhaustiveness-check`), and per-domain or per-provider copy lives in records (`capabilityWords` in vm-api, `capabilityCopy` on the site, the CLI's `providerNames` and `connectCopy`, the site's `providerIcons`, Home's `domainNames`). The `connection_domain` and `connection_provider` pgEnums are now built from `connectionDomains` and `connectionProviders` (drizzle-kit sees no change), so they can't drift. Checked by adding `ramp` to both lists: typecheck failed in vm-api, the CLI, the site, revoke, account deletion and the test helper, and lint failed on the three switches.
- **Revoking** takes a revoker per issuer (`Revokers`), and the sibling check only counts connections from the same issuer. `ConnectionUnavailableError` now carries the provider, so its reconnect link is the right flow.
- **Events** take any domain in `connectionDomains`; trigger `--account` accepts any connection domain.
- **Tests:** existing tests pass; three changed only in shape (the revoker as `{ google: … }` in two files, and the error's new provider argument). New: the traits and paths (`packages/domain/src/connections.test.ts`), no watch for a provider that doesn't sync, and neither sync nor watch from reconciliation for one.
