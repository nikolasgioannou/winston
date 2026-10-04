---
id: "50922c"
title: Winston can't check a site he deployed
status: done
priority: medium
labels:
  - backend
  - cli
parent: "57e0e7"
created_at: 2026-10-04T05:43:08.143Z
updated_at: 2026-10-04T19:48:08.946Z
blocked_by:
  - "28a208"
---

Found when Winston first deployed a site for real (28a208): after `winston site deploy` he tried `curl` and his browser on the address, and couldn't see whether the site worked. Sites are private, and his computer's browser isn't signed in to `runwinston.com`, so in production he'd hit the sign-in redirect; locally `sites.localhost` doesn't even resolve inside the VM. He told the user to check it instead.

**What to build**
- A way for Winston to request his user's site as its owner without a browser sign-in: e.g. `winston site fetch <site> [<path>] [--method POST --data …]`, which the backend serves by calling the site with an owner pass it mints itself (the gateway would need the pass signing key, or a signing endpoint on `web`). Bounded output per §11.
- Possibly a way to open it in his own browser window for visual checks; decide which one with the founder.

**Done when**
- [x] After deploying, Winston can confirm a page loads and an API route answers, on the local stack and in production

## As built

- **Chosen: fetching, not a browser window.** `winston site fetch <site> [<path>] [--method] [--data] [--type]`, backed by `POST /v1/sites/<site>/fetch` and `fetchSiteAsOwner` in `@winston/site-host/fetch` (docs/design.md §9a "Checking a site").
  - The gateway mints a one-minute owner pass with `SITES_PASS_KEY` and requests the site with it.
  - It returns the status, content type, `location`, size, and the body as text, cut at 8,000 characters.
  - Opening a site in Winston's own browser window, for visual checks, is left for later if it turns out to be needed.
- **Locally,** `*.sites.localhost` doesn't resolve from the host, so `SITES_CONNECT_URL` (added by `setup.sh`) points fetches at the sites service, with the site's address in the Host header. In production it fetches `https://<name>.runwinston.app` directly (d140ab gives the gateway the key).
- The background prompt now tells Winston to check what he deploys this way and fix it until it works.
- **Tests:** through the real local host (the owner reads a page, POSTs to an API, and another user's pass gets 403), the route (it needs a deployed site and a pass key), and the CLI. **Not yet seen in a real Winston run:** the app quit before the VM came back on the new image, and another checkout's services hold the dev ports now. It's on the founder's check at the end.

- Also fixed here: 0a3197's usage tests ran the job at a fixed noon UTC but created sites with the real clock, so they failed after noon. Sites in those tests now have a fixed creation time.
