---
id: "bf7f34"
title: Sites can't be shared with other people
status: done
priority: none
labels:
  - backend
  - cli
  - infra
parent: "57e0e7"
created_at: 2026-10-04T02:55:07.189Z
updated_at: 2026-10-04T05:46:40.117Z
blocked_by:
  - "28a208"
---

Anyone-with-the-link sharing (parent's spec, Access).

**What to build**
- `winston site share <site>` prints an unguessable link; opening it sets that site's cookie for the visitor, and the site works for them as for the owner. `winston site unshare <site>` makes it private again and rotates the link, so old links and cookies stop working.
- Winston shares when the user asks in chat; the prompt says so (no extra confirmation needed beyond the ask).

**Done when**
- [x] A shared link opens the site in a browser that isn't signed in
- [x] After unshare, the old link and an existing visitor's cookie are both refused (tests)

## As built

- `winston site share|unshare`, `POST /v1/sites/<site>/share|unshare`, `sites.share_key` and the `link` access (docs/design.md §9a "Sharing by link").
- The database keeps the key, so the CLI and the Sites page can show the link again; the routes map holds only its SHA-256, so nothing on Cloudflare can rebuild the link. The Worker hashes the cookie's key with WebCrypto, and the backend with `hashToken`: a test through the real workerd checks they agree.
- The link sets a cookie and redirects to `/`, so the key doesn't stay in the address bar. Sharing an already shared site returns the same link; sharing after unsharing makes a new one.
- Checked by tests (the handler, the routes, the CLI, and the local host with real workerd), not yet in a real browser: that's in the founder's check at the end.
- Also from the first real deploy: the deploy help now spells out `env.ASSETS` and `env.DB`. And `bun --watch` now restarts the `sites` service when the dispatch Worker changes, since the server bundles it rather than importing it.
