---
id: "89a2b0"
title: Build the account page with capability toggles
status: done
priority: none
labels:
  - connectors
  - m3
  - web
created_at: 2026-09-27T05:34:41.012Z
updated_at: 2026-09-30T04:38:10.796Z
blocked_by:
  - "4428cf"
---

`/accounts/<acct_id>` manages one connection: its alias, its capability toggles, reconnecting and disconnecting (docs/design.md §5 Permissions, §20).

- **Capabilities** per domain (§5): mail has `read`, `draft`, `send` and `modify_labels`. Calendar has `read`, `create`, `update`, `delete` and `rsvp`. Toggles save immediately, with clear saving and saved feedback. A capability whose Google scope wasn't granted is shown as unavailable, with a "reconnect to enable" action.
- **Alias:** editable, unique per user and domain, and shell-safe, since the CLI uses it (`--account work`). Validate accordingly.
- **Reconnect:** re-runs OAuth for that account.
- **Disconnect:** a confirmation dialog, then revoke the token with Google, mark the connection `disconnected`, and produce `system.app.disconnected`. Automatically cancelling the triggers scoped to this connection is wired in M7. Leave a clear hook for it.

The toggles are what the backend enforces on every connected-app call (M5). This page is only the UI and storage. Make sure the stored shape is exactly what the enforcement layer will read.

Add all states to the dev design view: toggles saving, toggle error, unavailable capability, disconnect confirmation, disconnected.

Tests: toggle updates, alias validation, disconnect revoking the token (with a stubbed Google) and flipping status.

## Outcome

- `/accounts/<id>`: alias, capability switches, reconnect and disconnect; list rows now link here.
- Stored shape for M5: `capabilities` stays a jsonb map naming every capability of the domain; `setCapability` merges one key (`||`), only for the owner and only for the domain's capabilities. `capabilityScopes` (`@winston/domain/connections`) maps each capability to the Google scope it needs; the loader reports the unavailable ones. Today every capability needs its domain's essential scope, so "unavailable" only appears if scopes are split later.
- Aliases: `aliasPattern` (shell-safe word, at most 32), unique per user and domain (checked, plus a new unique constraint); default aliases are now sanitized so they always match.
- Disconnect: marks `disconnected` at once, records `system.app.disconnected`, and queues a new `revoke_connection_token` job with an M7 hook for cancelling triggers. Since the site can't decrypt, the job runs in `agents` (which now loads the vault key): with the row locked, it revokes the grant with Google unless another live connection shares the Google account (revoking one grant revokes them all), then deletes the token (`token_ciphertext` is now nullable). Reconnecting after a disconnect tells Winston again.
- `ConfirmDialog` gained `defaultOpen` (for the design view) and no longer warns about its trigger wrapper.
- Dev design view: mail, toggle saving, saved, failed, unavailable capabilities, an expired calendar, the disconnect confirmation, disconnected.
- Tests: toggles (own connection and domain only), alias validation and uniqueness per domain, disconnecting (status, event, job, only once), the revoke job (revokes and deletes; skips revoking when a sibling uses the account; leaves a reconnected one alone), the revoke call (an already invalid token counts as revoked; other failures retry), alias rules.
- Checked live on the founder's personal mail account: toggling Send and Organize saved (with "Saved" feedback) and restored, an invalid name was refused with the rule, and a rename went through and back. Disconnect wasn't tried on the real account.
- Also noted live: the 4428cf flow connected personal mail and calendar with every scope granted and told Winston.

