---
id: "6457ed"
title: Winston can't keep accounts that require two-factor sign-in
status: backlog
priority: none
labels:
  - collab
  - spec
created_at: 2026-10-04T02:51:04.481Z
updated_at: 2026-10-04T02:51:04.481Z
blocked_by:
  - "ead827"
---

**Needs a spec with the founder before any building.** Raised while specifying Winston's own email address (ead827), 2026-10-03.

Once Winston has his own email address he can sign up for services in his own name. The founder's first example: a GitHub account for Winston so he can push to this repo. GitHub requires two-factor authentication for accounts that contribute code, and many other services require or push it too. To sign in again, Winston would need the second factor: usually a TOTP authenticator secret, sometimes recovery codes or a passkey.

Today nothing gives him one. His browser keeps sessions, but once a session lapses he can't sign back in without the user. And the obvious fix, storing the secret on his VM, conflicts with Invariant 1 in `docs/design.md` Part 3 (no externally usable credential on the VM), so any design needs the founder's agreement.

Questions the spec must answer:

- **Where secrets live:** in the backend, encrypted with KMS like Google tokens, with the VM asking for a current code through the CLI (`winston` → `winstond` → gateway), so the secret never reaches the VM. Or something else.
- **What counts as a second factor:** TOTP first; recovery codes; passkeys (the browser's own authenticator); SMS stays out of scope because Winston has no phone number.
- **Passwords:** where his passwords for these accounts live, under the same rule.
- **Trust:** which sites he may create accounts on and keep factors for, what the user sees and approves, and how the user revokes them.
- **Account deletion:** what happens to his accounts elsewhere and their secrets.
- **Policy:** each service's terms on accounts run by an agent (GitHub allows machine accounts that a person is responsible for).
