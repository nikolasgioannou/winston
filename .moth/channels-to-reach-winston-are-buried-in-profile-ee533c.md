---
id: "ee533c"
title: Channels to reach Winston are buried in Profile
status: todo
priority: none
labels:
  - ui
  - web
parent: "ead827"
created_at: 2026-10-04T02:55:27.221Z
updated_at: 2026-10-04T02:55:34.385Z
---

Telegram, the one way to reach Winston today, sits in a "Channels" card on Profile. Winston's own email address (ead827) is a second channel, and the founder wants the channels on a page of their own rather than mixed into the profile.

**What to build**

- A **Channels** page at `/channels`, in the sidebar between Connected accounts and Profile: "the ways you reach Winston"
- Move the Telegram row there unchanged (Connect, Change account, Disconnect, the Scan / Open here dialog)
- Profile keeps the You and Account cards
- Home's Telegram setup step links to `/channels`
- Dev design view: the Channels page in each Telegram state; Profile without the card
- `design.md` §20 updated (sidebar, routes table, Profile and Channels)

**Done when**

- [ ] `/channels` shows the Telegram row with every state it had on Profile, and linking, changing and disconnecting work from there
- [ ] Profile no longer shows Telegram
- [ ] The sidebar highlights Channels on `/channels`, and Home's Telegram step leads there
- [ ] `bun run check` passes
