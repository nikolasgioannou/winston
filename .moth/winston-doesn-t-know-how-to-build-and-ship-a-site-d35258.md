---
id: "d35258"
title: Winston doesn't know how to build and ship a site
status: done
priority: none
labels:
  - agents
  - prompts
parent: "57e0e7"
created_at: 2026-10-04T02:55:07.449Z
updated_at: 2026-10-04T06:32:47.627Z
blocked_by:
  - "bf7f34"
---

Prompt guidance so Winston builds sites well (parent's spec).

**What to build**
- Guidance on when to offer a site, the bundle layout, building in `~/sites/<name>`, trying it with `npx wrangler dev` before deploying, choosing a free name, sharing only when asked, and that sites start private.
- An eval with the real CLI against the local host: a static page, an app with an API and a database, a taken name, and a share request.

**Done when**
- [x] The eval's runs deploy working sites, recover from a taken name, and share only when asked

## As built

- "Sites" in `front-of-house.md`:
  - delegate building and changing sites;
  - sites start private; share by link only when asked, and say anyone with the link can open it;
  - `delete` destroys data, so confirm with `--dry-run` like mail; rollback is undoable, so just do it;
  - pass on `system.site.paused` in plain words (from 0a3197).
- "Sites" in `background.md`:
  - the folder layout and the Worker contract (`env.ASSETS`, `env.DB`), migrations applied once each;
  - deploy and redeploy; a variation when a name is taken;
  - don't share unless the brief says the user asked;
  - report the address as printed, and say it can't open private sites yet (50922c);
  - no secrets in sites, and no pages posing as real companies or login pages.
- **Dropped `npx wrangler dev`:** it needs Node and a wrangler config on the VM, which the image doesn't have. Checking a deployed site is 50922c.
- **Eval** (`bun run task:start` on the dev stack, the real CLI and local host, Sonnet at `low`; 12 runs in all). Every deploy worked in 2–5 steps. Static pages and both reading-list apps (`worker.js` on `env.DB` with a migration) stayed private. Both taken-name runs picked a variation and said why. Sharing returned the link. Runs that hit the 10-site cap (left by earlier runs) never deleted the user's sites: they listed likely duplicates and left the choice to the user.
- **Two things found and fixed in the eval:**
  - The first share runs failed because the local VM image predated `winston site share`. In production, winstond updates the CLI by itself.
  - The prompt named `runwinston.app` while the dev stack prints `sites.localhost`, so reports second-guessed the address. Both prompts now refer to "the address `winston site deploy` prints".
