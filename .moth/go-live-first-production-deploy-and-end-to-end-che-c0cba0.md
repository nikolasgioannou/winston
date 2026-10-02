---
id: "c0cba0"
title: "Go live: first production deploy and end-to-end check (with the founder)"
status: done
priority: none
labels:
  - collab
  - m4
created_at: 2026-09-27T05:36:33.552Z
updated_at: 2026-10-02T18:30:01.801Z
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

## As built

Closed 2026-10-02 at the founder's request to finish the remaining tickets; production has been in daily use since go-live (2026-09-30 onwards). From the checklist, in practice:

1–4. Done with the founder: allowlisted, signed in at runwinston.com, the EC2 VM provisioned and reached `ready`, Telegram connected through @RunWinstonBot.
5. Daily chat in production; replies, the typing indicator and steering are in use. (Reactions weren't separately checked.)
6. The computer in use: notes saved and read (e.g. passport details, flight plans), commands run. Photo/PDF/voice weren't individually confirmed on production; they're covered by tests and local checks.
7. Gmail and Google Calendar connected in production (and the calendar `invalid_client` fixed along the way: `prod:keys` now restarts the services that read a secret).
8. Model calls are logged with costs; `bun run prod costs` reads them (46ee9b).
9. The AWS budget alerts exist; the OpenRouter monthly limit was set; OpenRouter email alerts were skipped (the founder's call).
10. Deploys work end to end (now started by hand, decision #46) and VM binaries self-update; image changes roll in quiet hours (eadb89).

Surprises found and fixed along the way are in their own commits: deploy cancellations read as failures, `prod:keys` not restarting the gateway, the org policy on the Gmail publisher binding, and the gateway routing during deploys (f6b5a6).
