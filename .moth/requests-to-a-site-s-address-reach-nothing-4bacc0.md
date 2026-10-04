---
id: "4bacc0"
title: Requests to a site's address reach nothing
status: in-progress
priority: none
labels:
  - backend
  - infra
parent: "57e0e7"
created_at: 2026-10-04T02:55:07.033Z
updated_at: 2026-10-04T02:59:13.975Z
---

The dispatch Worker that routes `<name>.runwinston.app` to the site's user Worker (see the parent's spec), and the local stand-in. Built and checked locally; going live in production is its own ticket.

**What to build**
- The dispatch Worker in the repo (its own app; research how to build it with wrangler alongside the existing stack). It looks the hostname up in a Workers KV map the backend writes (site → script, owner, access, paused), and calls the user Worker with custom limits (CPU-ms, subrequests).
- Unknown names get a plain "no site here" page; paused sites a "paused" page. For now, every site is treated as private with no way in (the next ticket adds owner access), so nothing deployed is reachable by mistake.
- A `SiteHost` interface in the backend (like `VmProvider`): Cloudflare in production, and a local host for the dev stack serving sites at `<name>.sites.localhost` (research miniflare/workerd). Tests use the local host.
- docs/design.md: a new Sites section (routing, the KV map, the local host); docs/local-dev.md for the local host. Update `scripts/setup.sh` and `.vscode/` if a tool is added.

**Done when**
- [ ] A test site answers through the dispatch Worker on the local stack
- [ ] Unknown and paused names get their pages; CPU and subrequest limits are applied (a test Worker that loops is cut off)
