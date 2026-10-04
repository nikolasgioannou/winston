---
id: "bf7f34"
title: Sites can't be shared with other people
status: backlog
priority: none
labels:
  - backend
  - cli
  - infra
parent: "57e0e7"
created_at: 2026-10-04T02:55:07.189Z
updated_at: 2026-10-04T02:55:07.189Z
blocked_by:
  - "28a208"
---

Anyone-with-the-link sharing (parent's spec, Access).

**What to build**
- `winston site share <site>` prints an unguessable link; opening it sets that site's cookie for the visitor, and the site works for them as for the owner. `winston site unshare <site>` makes it private again and rotates the link, so old links and cookies stop working.
- Winston shares when the user asks in chat; the prompt says so (no extra confirmation needed beyond the ask).

**Done when**
- [ ] A shared link opens the site in a browser that isn't signed in
- [ ] After unshare, the old link and an existing visitor's cookie are both refused (tests)
