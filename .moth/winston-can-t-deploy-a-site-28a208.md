---
id: "28a208"
title: Winston can't deploy a site
status: backlog
priority: none
labels:
  - backend
  - cli
  - vm
parent: "57e0e7"
created_at: 2026-10-04T02:55:07.137Z
updated_at: 2026-10-04T02:55:07.137Z
blocked_by:
  - "901702"
---

`winston site deploy` and the data behind it (parent's spec: How Winston deploys, Addresses).

**What to build**
- Tables for sites (name, owner, access, paused, database id, current version) and versions (§14), and the `site` CLI domain following §11: `winston site deploy <dir> [--name <name>]`, `winston site list`, `winston site show <site>`. A deploy prints the address.
- The bundle format: a `public/` folder of static files, plus an optional `worker.js` (an ES module) and `migrations/*.sql`. Always deploy a script (a default one that only serves assets when the site has none); research whether assets-only user Workers are possible.
- The bundle goes through winstond to the backend, into S3 as a version, then to Cloudflare (static assets upload session, then the script with its bindings). The first deploy that has migrations creates the site's D1 database and binds it as `DB`; each deploy applies new migrations.
- Name rules: lowercase letters, digits and hyphens, a reserved list, first come first served; a taken name is a clear error so Winston can pick another.
- Caps checked by the server: at most 10 live sites per user, at most 25 MB per deploy.
- docs/design.md: the Sites section, §11 command reference, §14.

**Done when**
- [ ] Winston deploys a static site and a site with an API and a database from the VM, and the owner opens both
- [ ] A redeploy replaces the site and keeps its data; migrations apply once
- [ ] Taken and reserved names, an 11th site and an oversized bundle are refused with clear errors (tests)
- [ ] No Cloudflare credential is on the VM
