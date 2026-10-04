---
id: "50922c"
title: Winston can't check a site he deployed
status: backlog
priority: medium
labels:
  - backend
  - cli
parent: "57e0e7"
created_at: 2026-10-04T05:43:08.143Z
updated_at: 2026-10-04T05:43:08.143Z
blocked_by:
  - "28a208"
---

Found when Winston first deployed a site for real (28a208): after `winston site deploy` he tried `curl` and his browser on the address, and couldn't see whether the site worked. Sites are private, and his computer's browser isn't signed in to `runwinston.com`, so in production he'd hit the sign-in redirect; locally `sites.localhost` doesn't even resolve inside the VM. He told the user to check it instead.

**What to build**
- A way for Winston to request his user's site as its owner without a browser sign-in: e.g. `winston site fetch <site> [<path>] [--method POST --data …]`, which the backend serves by calling the site with an owner pass it mints itself (the gateway would need the pass signing key, or a signing endpoint on `web`). Bounded output per §11.
- Possibly a way to open it in his own browser window for visual checks; decide which one with the founder.

**Done when**
- [ ] After deploying, Winston can confirm a page loads and an API route answers, on the local stack and in production
