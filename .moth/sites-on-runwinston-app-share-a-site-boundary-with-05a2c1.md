---
id: "05a2c1"
title: Sites on runwinston.app share a site boundary with each other
status: in-progress
priority: low
labels:
  - infra
parent: "57e0e7"
created_at: 2026-10-04T02:55:07.552Z
updated_at: 2026-10-04T11:55:25.261Z
blocked_by:
  - "f432a3"
---

Sibling subdomains of one registrable domain are same-site, so one site could set cookies for `runwinston.app` that reach the others. Submit `runwinston.app` to the Public Suffix List (as `github.io` and `vercel.app` are), which makes each site its own site to browsers. Research the PSL's current requirements first; inclusion takes weeks.

**Done when**
- [ ] The PSL pull request is filed and linked here, and the dispatch Worker drops any cookie with `Domain=runwinston.app` from a site's responses meanwhile

## Progress

- **Done:** the dispatch Worker drops cookies a site sets with a `Domain` attribute (they'd reach `runwinston.app` and every other site), and any named like its own (`winston_site_*`), so a site can't replace its visitor's pass or share key (`withSafeCookies` in `dispatch/access.ts`, tested).
- **Waiting on the founder.** The PSL guidelines (checked 2026-10-04) require the domain to be registered for **more than 2 years past the request's date**, so `runwinston.app` needs extending in Cloudflare Registrar first. Only an authorized representative of the domain owner may submit. Validation is a `_psl` TXT record on `runwinston.app` holding the PR's URL. There's no service-level time.
- **Draft for the PR** (to `publicsuffix/list`, private section):

  ```
  // Winston : https://runwinston.com
  // Submitted by Nikolas Ioannou <...>
  runwinston.app
  ```

  Rationale: every `<name>.runwinston.app` is a separate site built for a different user of Winston, a personal assistant that deploys small websites. Listing `runwinston.app` keeps each site's cookies and storage separate from the others in browsers. Examples: `blog.runwinston.app` and `notes.runwinston.app` must not share cookies; `runwinston.app` itself serves nothing.
