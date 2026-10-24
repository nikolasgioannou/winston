---
id: "7f2b70"
title: Winston's browser can't open the user's private sites, and sites can't be
  renamed
status: todo
priority: low
labels:
  - sites
parent: "07ba81"
created_at: 2026-10-24T16:49:57.133Z
updated_at: 2026-10-24T16:50:33.764Z
---

**From the trace audit (07ba81):**

- **Oct 13:** three site tasks hit the runwinston.com sign-in ("Chrome here isn't signed in to Winston") and tested their UI against Python mocks instead of the live site. Each report says the live page was never clicked. `winston site fetch` requests the site as the user, but the browser can't.
- **Oct 13:** with no rename, "rename the site" became deploy a new site, then `site delete` the old one. The `--dry-run` was never shown to Nik, which goes against the site prompt. The rename also left stale site ids in notes and a garbled id in the next brief.

**What to build**

- A way for Winston's browser to open the user's own private sites signed in as the owner. One option is a short-lived owner link from `winston site open <name>` that opens in his window.
- `winston site rename <name> <new>`, which keeps the id, database and versions and moves the address.

**Done when**

- [ ] `winston browser open` on a private site of the user's shows the site, not the sign-in page (test)
- [ ] `site rename` keeps the database and the old address stops serving (test)
- [ ] The site prompt mentions both, and docs/design.md is updated
