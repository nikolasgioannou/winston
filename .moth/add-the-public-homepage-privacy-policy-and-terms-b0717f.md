---
id: "b0717f"
title: Add the public homepage, privacy policy and terms
status: todo
priority: none
labels:
  - m3
  - web
created_at: 2026-09-27T05:34:40.620Z
updated_at: 2026-09-27T05:34:40.652Z
blocked_by:
  - "5e3c6d"
---

Google's OAuth consent screen requires a homepage, a privacy policy and terms on a verified domain, even in testing mode (docs/design.md §9, §20).

Build `/`, `/privacy` and `/terms` as simple static routes using `packages/ui`:
- **Homepage:** short and honest. What Winston is (a personal assistant on Telegram with his own computer), that access is invite-only, and a sign-in link.
- **Privacy policy:** written plainly and **accurately for this design**. What's accessed (Gmail and Calendar content per the permissions the user grants), where it's stored (AWS `us-east-1`, the user's own VM, Postgres), which third parties process it (OpenRouter and the model providers behind it, TypeSafe for Jev, Telegram), retention, and deletion (deleting the account wipes everything, §13). Include the Google API Services User Data Policy "Limited Use" disclosure. Research exactly what Google requires in it for Gmail restricted scopes.
- **Terms:** short and sensible for an invite-only personal tool.

Draft the policy text and **have the founder review it**, since it's a legal-ish statement in their name. Add the pages to the dev design view. Once deployed (M4), the URLs go into the Google consent screen. The GCP runbook should already mention that.
