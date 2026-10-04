---
id: "048e42"
title: Winston can't see why his site's API is failing
status: backlog
priority: low
labels:
  - backend
  - cli
parent: "57e0e7"
created_at: 2026-10-04T02:55:07.500Z
updated_at: 2026-10-04T02:55:07.500Z
blocked_by:
  - "28a208"
---

`winston site logs <site>`: recent requests, errors and `console.log` output from the site's Worker, bounded per §11. Research Tail Workers or Workers Logs for user Workers in a dispatch namespace.

**Done when**
- [ ] An exception thrown by a site's Worker shows up in `winston site logs` within a minute
