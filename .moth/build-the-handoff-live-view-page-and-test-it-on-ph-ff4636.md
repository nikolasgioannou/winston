---
id: "ff4636"
title: Build the handoff live-view page and test it on phones (with the founder)
status: todo
priority: none
labels:
  - browser
  - collab
  - m8
  - web
created_at: 2026-09-27T05:42:03.975Z
updated_at: 2026-09-27T05:42:04.030Z
blocked_by:
  - "7b6af9"
  - "f0507c"
---

`/t/<token>` is the page the user opens from Telegram, almost always **on their phone**, to unblock Winston (docs/design.md §5 Browser, §20). It has no sidebar and needs no sign-in, since the token is the credential. It must work well on mobile.

Build with `packages/ui`:
- A canvas drawing the screencast frames, scaled to fit the phone while keeping coordinates accurate.
- **Touch → mouse mapping:** tap to click, drag to scroll, and long-press for right-click if needed. Map canvas coordinates back to page coordinates correctly across device pixel ratios.
- **Keyboard:** a real hidden `<input>` that summons the phone's keyboard and forwards keystrokes (including backspace, enter and paste), because typing a password or 2FA code is the most common reason for a handoff.
- **States:** connecting, live, reconnecting (network blips on phones are normal), expired/invalid link, and resolved ("You're done. Tell Winston in Telegram").
- A clear line telling the user to message Winston "done" when finished. Resuming happens in chat (§1).
- A small "open full desktop" link for native dialogs the screencast can't show. The next ticket builds it.

Add all states to the dev design view. **Test on real iPhone and Android devices with the founder.** This is the open question from product.md about mobile quality. Iterate on the feel together until typing a code and tapping buttons is comfortable.
