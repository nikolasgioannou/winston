---
id: "c0cba0"
title: "Go live: first production deploy and end-to-end check (with the founder)"
status: todo
priority: none
labels:
  - collab
  - m4
created_at: 2026-09-27T05:36:33.552Z
updated_at: 2026-09-27T05:42:59.290Z
blocked_by:
  - "0e0c6c"
  - "1867ba"
  - "1e6482"
  - "22f09d"
  - "3f95f4"
  - "550446"
  - "6882fb"
  - "68fe0c"
  - "8d94b2"
  - "a4de0d"
  - "bbfa17"
  - "d4bb0d"
  - "e1a361"
  - "ebd998"
  - "ee16f5"
  - "f661c5"
---

This is the moment the founder starts using the real Winston daily (docs/design.md §8d). Walk through it together and fix whatever breaks along the way, in follow-up tickets if needed.

The checklist:
1. Add the founder's email to the production allowlist (`bun run prod allowlist add …`).
2. Sign in at `runwinston.com`. The user is created with the correct names and time zone.
3. The home page shows the computer provisioning. An EC2 instance launches, the data volume mounts, and `winstond` registers and turns `ready`.
4. Connect Telegram via the QR code or button. Winston says hello through @RunWinstonBot.
5. Chat: replies arrive, steering works (send a correction mid-reply), the typing indicator shows, reactions are received.
6. The computer: ask Winston to run a command, save a note, and read it back. Send a photo and a PDF, and have him send a file back. Send a voice note.
7. Connect a Google account on `/accounts`, and toggle a capability. Mail and calendar commands arrive in M5, so this just checks storage and status.
8. Check the database record: model calls logged with costs, and cached tokens showing up on consecutive turns.
9. Check the budget alerts exist, and that the OpenRouter limit is set.
10. Push a trivial change and watch it deploy, including a CLI change reaching the VM via self-update.

Record anything surprising in the docs. Done when the founder is comfortable using production day to day.
