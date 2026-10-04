---
id: "4bacc0"
title: Requests to a site's address reach nothing
status: backlog
priority: none
labels:
  - backend
  - infra
parent: "57e0e7"
created_at: 2026-10-04T02:55:07.033Z
updated_at: 2026-10-04T02:55:07.033Z
blocked_by:
  - "f432a3"
---

The dispatch Worker that routes `<name>.runwinston.app` to the site's user Worker (see the parent's spec), and the local stand-in.

**What to build**
- The dispatch Worker in the repo (its own app; research how to build and deploy it with wrangler alongside the existing CI deploy, §8b). It runs on the `*.runwinston.app` route, looks the hostname up in a Workers KV map the backend writes (site → script, owner, access, paused), and calls the user Worker with custom limits (CPU-ms, subrequests).
- Unknown names get a plain "no site here" page; paused sites a "paused" page. For now, every site is treated as private with no way in (the next ticket adds owner access), so nothing deployed is reachable by mistake.
- A `SiteHost` interface in the backend (like `VmProvider`): Cloudflare in production, and a local host for the dev stack serving sites at `<name>.sites.localhost` (research miniflare/workerd). Tests use the local host.
- docs/design.md: a new Sites section (routing, the KV map, the local host); docs/local-dev.md for the local host. Update `scripts/setup.sh` and `.vscode/` if a tool is added.

**Done when**
- [ ] A hand-deployed test Worker in the namespace answers through the dispatch Worker in production, and the same test site answers on the local stack
- [ ] Unknown and paused names get their pages; CPU and subrequest limits are applied (a test Worker that loops is cut off)
- [ ] The dispatch Worker deploys from CI
