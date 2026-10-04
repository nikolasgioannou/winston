---
id: "57e0e7"
title: Let Winston build and deploy sites the user can reach and share
status: in-progress
priority: none
labels:
  - collab
  - infra
created_at: 2026-10-03T16:31:57.420Z
updated_at: 2026-10-04T02:59:13.924Z
---

The founder's idea (2026-10-03), specced together on 2026-10-03. Winston builds a small website or app (static pages, or pages with an API and a database) on his computer and deploys it to the internet, where the user can reach it and share it.

## Spec

**What can be deployed:** a site is static files plus, optionally, a JavaScript/TypeScript Worker for its API and a SQLite (D1) database. JS/TS only, because that's what the platform runs.

**Where it runs:** Cloudflare **Workers for Platforms** ($25/mo: 20M requests, 60M CPU-ms and 1,000 scripts included), in the Winston Cloudflare account that already holds `runwinston.com`'s DNS.
- One **dispatch namespace** holds every site as a user Worker, in Cloudflare's untrusted mode.
- Our **dispatch Worker** on `*.runwinston.app` maps the hostname to a site, checks access and pause state, and calls the site with **custom limits** (CPU-ms and subrequests per request).
- Each site that wants a database gets **its own D1 database**, bound as `DB`.
- AWS was considered (S3 + CloudFront + a Lambda per app + DSQL/DynamoDB). Rejected: we'd build the routing, per-app isolation and database glue ourselves, while this platform is built for running untrusted code from many authors.

**Addresses:** `<name>.runwinston.app`, one flat namespace, first come first served, with no usernames (`runwinston.com` is the site, `runwinston.email` is for email, `runwinston.app` is for sites). A separate domain, not a subdomain of `runwinston.com`: `*.runwinston.com` would be same-site with our site (cookies ride along on form posts), and a flagged page would hurt the main domain's reputation. If a name is taken, Winston picks a free variation. Names are lowercase, with a reserved list (`www`, `api`, `admin`, `mail`, `winston`, …).

**How Winston deploys:** he writes the site in `~/sites/<name>` on his computer and can try it there (`npx wrangler dev` needs no Cloudflare login). `winston site deploy <dir>` sends the bundle through winstond to the backend, which stores it in S3 as a new version and uploads it to Cloudflare with the backend's API token. **No Cloudflare credential ever reaches the VM** (invariant 1 holds; no invariant changes).

**Access:**
- **Private by default:** only the owner, signed in. The owner gets in through a sign-in handoff from `runwinston.com`: a short-lived signed ticket, redeemed by the dispatch Worker, which sets its own host-only cookie (the same pattern as the browser page's viewer ticket, §13).
- **Anyone with the link:** an unguessable share link that sets a cookie for that site. Revoking it rotates the link.
- Winston may share a site by link from chat when the user asks. Fully public sites (no link needed) are out of scope for now.

**Versions:** every deploy is a version, and the backend keeps each bundle in S3, because Cloudflare doesn't version user Workers. Rollback redeploys an older bundle. The database isn't rolled back with the code.

**Guardrails (server-enforced, not prompt):**
- **Per user:** at most 10 live sites; at most 25 MB per deploy; the last 10 versions kept; a size cap per database.
- **Per site:** CPU and subrequest limits per request; a monthly request cap. A site over its cap pauses with a "paused" page, and Winston tells the user.
- **Spend:** hosting usage goes into `cost_ledger`; a monthly hosting cap per user; a global kill switch that pauses every site; a Cloudflare billing alert.

**Where the user sees them:** a **Sites** page on the website (list, open, access, versions and rollback, take down), and the `winston site` commands (§11 conventions).

**Lifecycle:** taking a site down deletes its Worker, database and bundles and frees the name. Account deletion does the same for all of a user's sites.

**Local development:** the local stack serves sites with a local site host (like local Docker VMs stand in for EC2), so nothing local touches Cloudflare. Production is the only environment on Cloudflare.

**Out of scope for now:** public sites, custom domains, other languages, secrets for apps, scheduled jobs.

The sub-tickets below build this. `docs/` gets each part as it's built.
