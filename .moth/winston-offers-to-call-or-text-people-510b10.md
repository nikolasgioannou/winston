---
id: "510b10"
title: Winston offers to call or text people
status: todo
priority: low
labels:
  - agents
  - prompts
parent: "07ba81"
created_at: 2026-10-24T16:49:57.080Z
updated_at: 2026-10-24T16:50:33.712Z
---

Winston has no phone or SMS, but offers both.

**From the trace audit (07ba81):**

- Oct 14: "want me to text him right now to ask who you're meeting?"
- Oct 15: "Want me to check hours/call ahead for either?", "want me to call one of them?"
- Oct 11: "Want me to call the office (212-644-1501)… or do you have portal login saved somewhere I could use?". This came at a Cloudflare check that should have been a handoff, and Winston asked for the user's password.

**What to build**

- One line in both prompts: no calls or texts; offer email, the web, or a draft for the user to send instead. Never ask for a password: logins are a handoff.

**Done when**

- [ ] Replay of the Oct 15 frame-shop turn offers only things Winston can do (3/3)
- [ ] docs/design.md updated
