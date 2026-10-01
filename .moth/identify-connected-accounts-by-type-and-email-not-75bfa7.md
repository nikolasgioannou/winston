---
id: "75bfa7"
title: Identify connected accounts by type and email, not aliases
status: done
priority: none
labels:
  - m3
  - web
created_at: 2026-09-30T22:21:08.160Z
updated_at: 2026-09-30T23:34:47.634Z
blocked_by:
  - "89a2b0"
---

The founder's feedback after M3: connected accounts shouldn't have names ("personal", "work"). An account is identified by its type (Mail, Calendar) and its address.

- **Data:** drop `connections.alias`, its per-user-and-domain unique constraint, `aliasPattern`, `defaultAlias`, `renameConnection` and their tests. The `system.app.connected`, `…disconnected` and `auth_*` payloads lose `alias`, and Home's attention items and the prompt stop using it.
- **Accounts list:** each row is "Mail" or "Calendar" with the address under it. Also fix the row hover: the highlight should span the card's full width, not stop short of its edges.
- **Account page:** the address as the title, with "Gmail" or "Google Calendar" under it; the Name section goes.
- **Docs:** design.md's CLI spec moves from `--account <alias>` to `--account <email>` (still optional when the user has one account of that type), `accounts get` takes an id or an address, and Winston names accounts by address in chat. Update §12a, §14 and §20 to match.

Pause for the founder's review before committing.

## Outcome

- Aliases are gone: the `alias` column and its unique constraint (migration), `aliasPattern`, `defaultAlias`, `renameConnection`, the rename server function and the account page's Name section. Event payloads (`system.app.connected`, `…disconnected`, `auth_*`) no longer carry `alias`, and the prompt's description of the connected event says domain and address.
- Accounts list: the provider ("Gmail", "Google Calendar") with a "Mail" or "Calendar" badge, and the address under it (the founder's call during review; brand icons come with 856256), in a new `LinkCard` (`packages/ui`) whose rows span the card edge to edge, so the hover fills them; dividers stay inset, and a hovered or focused row hides the dividers above and below it (the founder's request, after Linear).
- Account page: the address as the title (wrapping if long), "Gmail" or "Google Calendar" under it.
- Also from review: the account page's back link is now a ghost `Button` rendering the router `Link` (it was hand-styled), and the subtext under the Connected accounts and Home titles is gone.
- Home's attention items read "Mail access for <address> expires soon" / "… expired".
- design.md: accounts are known by domain and address; the CLI spec moves to `--account <email>` (or an `acct_` id), `accounts get <acct_id|email>`; the CLI's shared `--account` flag help says `<email>`.
- Tests updated (the alias tests removed); checked the list hover and the account page in the dev design view.

