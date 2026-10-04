---
id: "4bacc0"
title: Requests to a site's address reach nothing
status: done
priority: none
labels:
  - backend
  - infra
parent: "57e0e7"
created_at: 2026-10-04T02:55:07.033Z
updated_at: 2026-10-04T03:21:06.504Z
---

The dispatch Worker that routes `<name>.runwinston.app` to the site's user Worker (see the parent's spec), and the local stand-in. Built and checked locally; going live in production is its own ticket.

**What to build**
- The dispatch Worker in the repo (its own app; research how to build it with wrangler alongside the existing stack). It looks the hostname up in a Workers KV map the backend writes (site → script, owner, access, paused), and calls the user Worker with custom limits (CPU-ms, subrequests).
- Unknown names get a plain "no site here" page; paused sites a "paused" page. For now, every site is treated as private with no way in (the next ticket adds owner access), so nothing deployed is reachable by mistake.
- A `SiteHost` interface in the backend (like `VmProvider`): Cloudflare in production, and a local host for the dev stack serving sites at `<name>.sites.localhost` (research miniflare/workerd). Tests use the local host.
- docs/design.md: a new Sites section (routing, the KV map, the local host); docs/local-dev.md for the local host. Update `scripts/setup.sh` and `.vscode/` if a tool is added.

**Done when**
- [x] A test site answers through the dispatch Worker on the local stack
- [x] Unknown and paused names get their pages; CPU and subrequest limits are passed to the site (enforced only in production: checked in d140ab)

## As built

- `packages/site-host`: `SiteHost` (`putScript`, `deleteScript`, `setRoute`), `SiteRoute` and `siteNameOf`, and `localSiteHost(adminUrl)`. The Cloudflare implementation moved to d140ab, since nothing can check it before the account exists.
- `apps/sites/src/dispatch`: `handler.ts` (platform-free, unit-tested), its pages, and the local entry. The Cloudflare entry moved to d140ab for the same reason.
- `apps/sites/src/local`: the `sites` service in `bun dev` (3003, admin API on 3004). Miniflare can't emulate dispatch namespaces, so the local entry reaches sites through service bindings. Miniflare's `setOptions` crashes under Bun, so every change rebuilds Miniflare from disk instead (about 50 ms). Miniflare is pinned to 4.20260730.0, because v5 is an alpha with a new options shape.
- **Limits aren't enforced locally** (workerd ignores them). The handler passes them and turns a throwing site into the "failed" page; d140ab checks the real cut-off.
- The integration test opens sites with a test-only `admitAll`, which 901702 replaces with owner sign-in. Run by hand: an unknown name got 404 and a deployed site got the private page.
