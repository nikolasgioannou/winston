---
id: "05a2c1"
title: Sites on runwinston.app share a site boundary with each other
status: backlog
priority: low
labels:
  - infra
parent: "57e0e7"
created_at: 2026-10-04T02:55:07.552Z
updated_at: 2026-10-04T02:55:07.552Z
blocked_by:
  - "f432a3"
---

Sibling subdomains of one registrable domain are same-site, so one site could set cookies for `runwinston.app` that reach the others. Submit `runwinston.app` to the Public Suffix List (as `github.io` and `vercel.app` are), which makes each site its own site to browsers. Research the PSL's current requirements first; inclusion takes weeks.

**Done when**
- [ ] The PSL pull request is filed and linked here, and the dispatch Worker drops any cookie with `Domain=runwinston.app` from a site's responses meanwhile
