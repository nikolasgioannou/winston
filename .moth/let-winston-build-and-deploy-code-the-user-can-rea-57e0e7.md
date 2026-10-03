---
id: "57e0e7"
title: Let Winston build and deploy code the user can reach
status: backlog
priority: none
labels:
  - collab
  - infra
  - spec
created_at: 2026-10-03T16:31:57.420Z
updated_at: 2026-10-03T16:31:57.420Z
---

**Needs a spec with the founder before any building.** The founder's idea (2026-10-03), captured at a high level.

The user asks Winston to build something (a small site, a tool, an API, a script that runs on a schedule) and he writes the code and deploys it to the internet, where the user can reach it.

Questions the spec must answer:
- **What kinds of things:** static sites, web apps with a backend, scheduled jobs, bots? Start narrow.
- **Where it runs:**
  - on the user's VM behind a tunnel or reverse proxy (the VM has no inbound access today, an invariant: §15);
  - on a platform Winston deploys to (Cloudflare Pages/Workers, Fly, Vercel, a container service);
  - or something Winston hosts per user.
- **Addresses:** e.g. `<app>.<user>.runwinston.com`, or the platform's own. Custom domains?
- **Access:** public, or private to the user (a login, a secret link)? How the user finds their deployed things (`winston` commands, a page on the site).
- **Safety:** code Winston writes and runs; abuse (hosting phishing or spam pages); resource limits; what happens when someone else's request reaches it.
- **Costs:** per-user spend in the cost ledger, and caps.
- **Lifecycle:** updating, taking it down, logs, what happens on account deletion.
- **Accounts:** whose platform account it uses (Winston's own, per user, or the user's).
- The security model in §13 and the invariants in Part 3 may need changing; that needs the founder's agreement.
