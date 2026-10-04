---
id: "363358"
title: runwinston.email has no mail service behind it
status: todo
priority: none
labels:
  - collab
  - infra
parent: "ead827"
created_at: 2026-10-04T02:55:27.274Z
updated_at: 2026-10-04T02:55:34.438Z
---

Winston's mail needs a domain and an email service before anything can be sent or received (ead827). The founder chose `runwinston.email` (apart from `runwinston.com`, the site, and `runwinston.app`, apps Winston deploys) and Amazon SES. **Done together with the founder:** buying the domain, adding DNS records and asking AWS for production access are theirs.

**What to build**

- Research current SES receiving and sending setup first (receipt rule sets, S3 and SNS actions, Easy DKIM, custom MAIL FROM, SNS message signatures).
- The founder buys `runwinston.email` with Cloudflare Registrar, in the Winston Cloudflare account.
- CDK (`infra/`): an SES domain identity for `runwinston.email` with Easy DKIM, a custom MAIL FROM subdomain, a configuration set publishing bounces and complaints, a receipt rule set that accepts mail for the domain and writes it to an S3 bucket (encrypted, account-private) with an SNS notification, and the SNS topics the `api` will subscribe to (its endpoints come in later tickets).
- DNS in Cloudflare, by hand: MX to SES inbound in us-east-1, the three DKIM CNAMEs, SPF for the MAIL FROM domain, DMARC (`p=quarantine` to start, with reports to an address we read).
- The SES production-access request (out of the sandbox), filed by the founder.
- How local development receives mail: through the `dev.runwinston.com` tunnel like Gmail push, or a script that injects a raw message; decide and document.
- A runbook, `docs/runbooks/email.md`, and `design.md` §8 and §19 updated.

**Done when**

- [ ] The identity shows DKIM and MAIL FROM verified, and a test message to a Gmail address passes SPF, DKIM and DMARC (checked in "Show original")
- [ ] Mail sent to any `@runwinston.email` address lands in the S3 bucket and publishes an SNS notification
- [ ] SES production access is granted
- [ ] The runbook covers every manual step and how to check each one
