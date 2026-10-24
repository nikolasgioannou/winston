---
id: "f98e33"
title: Winston doesn't use his memory when the answer is in it
status: in-progress
priority: medium
labels:
  - agents
  - prompts
parent: "07ba81"
created_at: 2026-10-24T16:49:56.921Z
updated_at: 2026-10-24T19:13:39.436Z
---

The prompt says to check notes and search history. In practice Winston skips both when the request doesn't obviously point there.

**From the trace audit (07ba81):**

- **Oct 14, 14:17:** "I sent a list of all my tx earlier". Winston listed `~/inbox`, read the first lines of four PDFs, searched mail for CSVs, and asked Nik to resend: "It may not have come through". He never ran `winston history search` and never opened the photos in `~/inbox`. Nik dropped the question.
- **Oct 13:** Winston didn't read `preferences.md` before offering meeting times. He invented a reason for a busy block, and didn't save the standing Amex 11:30–1 Nik told him about.
- **Oct 2, 22:45:** the travel-estimate preference saved 4.5 hours earlier was ignored.
- **Oct 3:** the "180 Hester not 181" address was never saved ("Already correct on my end").
- **Oct 12:** the front didn't read `~/notes/sites/britishairways.com.md`, which had been written 7 hours earlier, and opened a made-up BA URL. Only `background.md` mentions site notes.
- `preferences.md` has become a catch-all. New to-dos were filed there as "FYI, no action needed" (Oct 5).

**What to build**

- **Front-of-house prompt:**
  - when the user refers to something they sent or said before, search history first (and look at the files from that time, images included) before asking again;
  - read `preferences.md` before scheduling;
  - read the site's notes before using a site.
- **Saving:** a standing fact the user states (an address, a recurring meeting) is saved in the same turn, to a file for that person or topic, not to `preferences.md`.

**Done when**

- [ ] Replay of the Oct 14 "list I sent you earlier": found through history or the inbox photo (3/3)
- [ ] Replay of the Oct 13 scheduling turn: preferences read and the Amex block saved (3/3)
- [ ] docs/design.md updated

## Progress (2026-10-24)

- **`front-of-house.md`, "Your memory is files":**
  - when the user says they already sent or told him something, search history first and look at the files from that time, images included, before asking again;
  - a standing fact they state is saved that turn, in the file for that person or topic; `preferences.md` holds preferences and routines, and to-dos go in `~/notes/todo.md`.
- **`front-of-house.md`, "The browser":** read `~/notes/sites/<domain>.md` before using a site. Before, only `background.md` said this.
- **Not changed:** "read `preferences.md` before scheduling" was already in the prompt ("Mail and calendar"). The Oct 13 miss was adherence, which the replays will measure.
- **Held-out replay case:** `memory-sent-earlier`.
- **Left:** run it, plus a production export of the Oct 13 scheduling turn. Blocked: the dev OpenRouter key is out of credit. Then record in docs/design.md and close.
