---
id: "17f478"
title: Lock websites per agent to avoid collisions
status: done
priority: none
labels:
  - browser
  - m8
created_at: 2026-09-27T05:42:03.851Z
updated_at: 2026-10-02T02:22:43.316Z
blocked_by:
  - "0451df"
---

All agents share one logged-in Chrome profile, so two tasks acting on the same site at once (the same Amazon cart, or two logins) would collide. **Only one run acts on a given website at a time** (docs/design.md §5 Browser).

Implement domain locks in `winstond`:
- Acting commands (`navigate`, `click`, `type`, `select`, `press`, `scroll`, `click-xy`, `eval`) acquire the lock for the window's registrable domain (eTLD+1, so `www.amazon.com` and `smile.amazon.com` share a lock; research a public-suffix library) before acting.
- Locks belong to a run, with a TTL refreshed while the run keeps acting. They're released when the run's window closes, the run ends, or the TTL lapses (so a crashed run doesn't hold a site forever).
- A conflict returns **exit code 6** with who holds it and a hint: wait, or work on something else. The agent decides.
- **Read-only commands (`snapshot`, `screenshot` and `--window` peeks) never need locks.**
- `browser windows` shows who holds which domain.

Tests: lock acquisition and release, the eTLD+1 grouping, TTL expiry, conflict exit codes, and peeks bypassing locks.

## As built

- `locks.ts`: eTLD+1 via `tldts` 7.4.16 (`allowPrivateDomains`), host for IP/localhost, nothing for blank/data pages. TTL 5 min, renewed per acting command; released when the run's windows all close or Chrome restarts.
- Acquired by open/navigate (destination, history entry for back/forward), every action, and eval; never by snapshot, screenshot or peeks. Conflict: exit 6 naming the holder and window.
- `browser windows` shows `holds <domain>`.
- Tests: `locks.test.ts` and a registry test with two runs.

