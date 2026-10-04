---
id: "363358"
title: runwinston.email has no mail service behind it
status: in-progress
priority: none
labels:
  - collab
  - infra
parent: "ead827"
created_at: 2026-10-04T02:55:27.274Z
updated_at: 2026-10-04T03:31:52.630Z
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

## Progress (2026-10-03)

**Built:** the `Mail` stack (`infra/src/mail.ts`): the SES identity for `runwinston.email` (Easy DKIM, MAIL FROM `mail.runwinston.email`, bounce on MX failure), the `Sending` configuration set publishing bounces, complaints and deliveries to the `SendingEvents` topic, the `Receiving` rule set (every address on the domain, scanned, TLS required, raw mail to the Data stack's new `InboundMail` bucket under `inbound/`, notifying the `Inbound` topic) made active by a custom resource, SHA256-signed topics, and the DKIM records as outputs. Stack tests cover it. Runbook: `docs/runbooks/email.md`.

**Decided from current docs:** classic receipt rules, not SES Mail Manager ($50 a month per ingress endpoint before any mail); the S3 action's `kmsKey` left off (it's client-side encryption needing an S3 encryption client), bucket encryption instead; DMARC starts at `quarantine` (a new domain, as AWS recommends), with no `rua` until a mailbox can own reports; **local stacks don't receive real mail**, since SES allows one active rule set per account and region: 9ad1b4 hands the api raw messages locally instead. The topics' subscriptions to the api come with its endpoint (9ad1b4, 201a9b).

**Waiting on the founder:** buying `runwinston.email`, the deploy, the DNS records, and the production-access request (runbook steps 1–4), then the checks.
