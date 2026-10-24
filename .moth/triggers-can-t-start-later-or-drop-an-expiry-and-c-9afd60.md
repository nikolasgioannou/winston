---
id: "9afd60"
title: Triggers can't start later or drop an expiry, and calendar flags are easy
  to guess wrong
status: todo
priority: low
labels:
  - cli
parent: "07ba81"
created_at: 2026-10-24T16:49:57.026Z
updated_at: 2026-10-24T16:50:33.660Z
---

**From the trace audit (07ba81):**

- **Oct 12:** "Remind me some times throughout the day… starting this Thursday" became `--cron "0 10,13,17 * * *"`, firing from Monday, with a note telling the run to stay silent until Thursday. That's 7 wasted runs. It also never expires.
- **Oct 8:** `trigger update` couldn't clear `--expires`, so Winston deleted and recreated the trigger.
- **Background runs guessed `calendar list/free` flags** that don't exist: `--from`, `--to`, `--start`. This happened Oct 5, 6, 7, 8 and 15. On Oct 8 one run gave up on a clash check for a call 20 minutes away.
- **`calendar free --hours 0-23`** silently drops 23:00–24:00 (used three times on Oct 5 to mean "all day").

**What to build**

- `trigger create --cron … --starts <time>`, which sets the first fire on or after that time.
- `trigger update --no-expires`.
- `calendar list/free` accept `--from`/`--to` as aliases of `--since`/`--until`, or the error names the right flag.
- `--hours 0-24`.
- Prompts and docs/design.md updated.

**Done when**

- [ ] A cron trigger with `--starts` first fires at the start (test)
- [ ] `trigger update --no-expires` clears the expiry (test)
- [ ] `calendar list --from` works or names `--since` (test)
- [ ] `--hours 0-24` covers the whole day (test)
