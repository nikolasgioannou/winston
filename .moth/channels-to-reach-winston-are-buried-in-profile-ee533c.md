---
id: "ee533c"
title: Channels to reach Winston are buried in Profile
status: done
priority: none
labels:
  - ui
  - web
parent: "ead827"
created_at: 2026-10-04T02:55:27.221Z
updated_at: 2026-10-04T03:02:39.142Z
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

- [x] `/channels` shows the Telegram row with every state it had on Profile, and linking, changing and disconnecting work from there
- [x] Profile no longer shows Telegram
- [x] The sidebar highlights Channels on `/channels`, and Home's Telegram step leads there
- [x] `bun run check` passes

## As built

`/channels` (`src/pages/channels-page.tsx`, `routes/_authed/channels`, loader `getChannelsState`) holds the Telegram row moved from Profile unchanged, in one card with no section title, like Connected accounts. The sidebar gains Channels (`MessagesSquare`) between Connected accounts and Profile. Profile keeps You and Account, and its loader no longer reads Telegram.

**Differs from the plan:** Home's setup step still links Telegram in place (button and QR) rather than sending the user to `/channels`, since that's the first-run path and leaving the page would be a step backwards. So the third box is true for the sidebar; Home didn't need to change.

Checked in the dev design view (Channels and Profile, desktop). `design.md` §20 and §7, and `product.md` §1 updated.
