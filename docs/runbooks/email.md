# Winston's email (`runwinston.email`)

Winston's own addresses are `<name>@runwinston.email` (ead827). The domain is apart from `runwinston.com` (the site and sign-in) and `runwinston.app` (apps Winston deploys), so a deliverability problem with his mail can't touch either. Amazon SES in `us-east-1` sends and receives for it; the `Mail` stack (`infra/src/mail.ts`) holds the SES side and the `Data` stack holds the `InboundMail` bucket. Like `runwinston.com`, the domain is registered with Cloudflare Registrar in the Winston Cloudflare account, and its DNS records are added there by hand ([dns.md](dns.md) explains why). **Every record is "DNS only"** (grey cloud).

## What the Mail stack holds

- **Sending:** an SES domain identity for `runwinston.email` with Easy DKIM (2048-bit RSA), a custom MAIL FROM domain `mail.runwinston.email` (mail bounces rather than falls back if its MX is missing), and the `Sending` configuration set, which publishes bounces, complaints and deliveries to the `SendingEvents` topic.
- **Receiving:** the `Receiving` receipt rule set with one rule for every address on the domain (not its subdomains): spam and virus scanning on, TLS required, and an S3 action writing the raw message to the `InboundMail` bucket under `inbound/<SES message id>` and notifying the `Inbound` topic. SES can only have **one active rule set per account and region**, and CloudFormation can't activate one, so a custom resource calls `setActiveReceiptRuleSet` on deploy (and clears it if the stack is deleted). Nothing else in `winston-prod` may use SES receiving.
- **Topics** sign with SHA256 (`SignatureVersion` 2), which the api verifies. `Inbound` is subscribed to `https://api.runwinston.com/webhooks/ses`, which confirms the subscription itself (a signed `SubscriptionConfirmation`); `SendingEvents` is subscribed to the same URL; its bounces and complaints suppress addresses.
- Classic receipt rules rather than SES Mail Manager: Mail Manager's ingress endpoint costs $50 a month before any mail, and receipt rules do everything this needs (checked 2026-10-03).

## Setting it up

1. **Buy the domain** (founder): Cloudflare dashboard → Domain Registration → Register Domains → `runwinston.email` (about $24 a year, at cost).
2. **Deploy** the `Mail` stack. It deploys with everything else (`cdk deploy --all`, [deploys.md](deploys.md)); on its own: `AWS_PROFILE=winston-prod bunx cdk deploy winston-data winston-mail` from `infra/`. The identity can exist before its records do; it verifies once they resolve.
3. **Add the records** (founder) in Cloudflare (runwinston.email → DNS → Records). The DKIM targets are the stack's outputs `Mail.DkimRecord1`–`3` (`aws cloudformation describe-stacks --stack-name winston-mail --query 'Stacks[0].Outputs'`, or the deploy's log). Added 2026-10-05; they resolved within minutes and SES emailed "DKIM setup SUCCESS" and "Custom MAIL FROM Domain Setup SUCCESS":

   | Name                                          | Type  | Content                                               | Purpose                            |
   | --------------------------------------------- | ----- | ----------------------------------------------------- | ---------------------------------- |
   | `@`                                           | MX    | `inbound-smtp.us-east-1.amazonaws.com`, priority 10   | Receiving                          |
   | `yvgnbpwfqj4s3spehj6zrr56gfq2l5af._domainkey` | CNAME | `yvgnbpwfqj4s3spehj6zrr56gfq2l5af.dkim.amazonses.com` | DKIM (and verifies the domain)     |
   | `nzolkxfs4fgpow32v2rl3rtr723kafuk._domainkey` | CNAME | `nzolkxfs4fgpow32v2rl3rtr723kafuk.dkim.amazonses.com` | DKIM                               |
   | `cnomigjrf5t2iv4umjhsnstwl4xymyly._domainkey` | CNAME | `cnomigjrf5t2iv4umjhsnstwl4xymyly.dkim.amazonses.com` | DKIM                               |
   | `mail`                                        | MX    | `feedback-smtp.us-east-1.amazonses.com`, priority 10  | MAIL FROM (bounces come back here) |
   | `mail`                                        | TXT   | `v=spf1 include:amazonses.com ~all`                   | SPF for the MAIL FROM domain       |
   | `_dmarc`                                      | TXT   | `v=DMARC1; p=quarantine; adkim=r; aspf=r`             | DMARC                              |

   `mail` must have exactly that one MX and is never used as an address. DMARC starts at `quarantine` rather than `none`: the domain is new, so there's no existing mail to break, and AWS recommends a strict policy for new domains. There's no `rua` report address yet, since reports would arrive at an address no mailbox owns; add one once a mailbox for them exists.

4. **Ask AWS for production access** (founder): sign in to the console through the access portal as winston-prod (the account menu shows `7665-7708-5959`), region **N. Virginia**, then SES → **Get set up** → **Request production access**. The form asks only for the mail type (**Transactional**), the website (`https://runwinston.com`) and a contact language; there's no box for the use case. So the first answer is an automated one asking for details (on 2026-10-05 it came within minutes, and `aws sesv2 get-account` showed the review as `DENIED`, case `179120791100829`). **Reply in the console** (Support Center → Your support cases → the case → Reply), not to the email: it comes from `no-reply-aws@amazon.com`, which bounces. The answers they ask for, as sent:
   - **Website:** runwinston.com; each user can give their assistant an address on runwinston.email (verified, Easy DKIM, MAIL FROM `mail.runwinston.email`, DMARC).
   - **Email type:** transactional only: replies on threads the user copied the assistant on, writing to a company about something the user forwarded, and sign-ups the user asked for. Never marketing or bulk.
   - **Volume:** a few dozen users; under 100 a day at first, a few thousand a month at most; capped at 100 per user per 24 hours.
   - **Recipients:** no lists; people already on a thread the user brought the assistant into, or a company the user asked it to contact. Anything beyond the user's request is approved by the user first.
   - **Bounces and complaints:** the configuration set publishes them to SNS, delivered to our signed-checked webhook; permanent bounces and complaints suppress the address, and sending to it is refused.
   - **Sample:** a reply-all offering meeting times on a thread the user copied the assistant on, signed "Winston".

   Until it's granted SES is in the **sandbox**: it can send only to verified addresses, 200 a day and 1 a second. Receiving isn't limited by the sandbox. Verifying the domain covers every address on it; nothing else needs verifying.

## Checking it

- **The api's subscriptions:** SNS asks for confirmation as soon as the Mail stack creates a subscription, which in a deploy is before the api has the new route, so the first request can fail. SNS console → Topics → the `Inbound` and `SendingEvents` topics → Subscriptions: each `https` one must say **Confirmed**. If it says Pending confirmation, select it and **Request confirmation**; the api confirms within seconds (its log says "confirmed the SNS subscription"). A pending request expires after three days.

- **Verified:** SES console → Identities → `runwinston.email` shows Verified, DKIM Successful and MAIL FROM Successful; or `aws sesv2 get-email-identity --email-identity runwinston.email --profile winston-prod` (`VerifiedForSendingStatus: true`, `DkimAttributes.Status: SUCCESS`, `MailFromAttributes.MailFromDomainStatus: SUCCESS`).
- **DNS:** `dig +short MX runwinston.email`, `dig +short MX mail.runwinston.email`, `dig +short TXT mail.runwinston.email`, `dig +short TXT _dmarc.runwinston.email`, and each DKIM CNAME.
- **Receiving:** `aws ses describe-active-receipt-rule-set --profile winston-prod` names the `Receiving` set. Send a message from any address to `test@runwinston.email`; within a minute an object appears under `inbound/` in the `InboundMail` bucket (`aws s3 ls s3://<bucket>/inbound/ --profile winston-prod`), and the `Inbound` topic's delivery metrics count one notification. Delete the test object afterwards: it's someone's mail.
- **Sending:** while in the sandbox, verify your own address first (`aws sesv2 create-email-identity --email-identity you@example.com`), then `aws sesv2 send-email --from-email-address test@runwinston.email --destination ToAddresses=you@example.com --content 'Simple={Subject={Data=Test},Body={Text={Data=Hello}}}' --configuration-set-name <Sending set> --profile winston-prod`. In Gmail, **Show original** must say SPF, DKIM and DMARC **PASS**, with `mail.runwinston.email` as the SPF domain and `runwinston.email` as the DKIM one.
- **Production access:** `aws sesv2 get-account --profile winston-prod` shows `ProductionAccessEnabled: true`.

## Local development

Local stacks don't receive real mail: SES allows one active receipt rule set per account and region, and that's production's. Instead, hand the local stack a raw message:

```sh
bun run mail:receive message.eml                       # to its To and Cc addresses on runwinston.email
bun run mail:receive message.eml --to ada@runwinston.email
```

It leaves the message in `.data/inbound-mail/inbound/` (where `INBOUND_MAIL_DIR` points) and queues the same `receive_mail` job SES's notification would, with every verdict PASS; the running `agents` stores it. A message to an address no mailbox takes is logged as a bounce ("would bounce mail"), since there's no SES to bounce through. Save a message from any mail client as `.eml` to get one.

Sending from his address locally is logged ("would send mail") and stored in his mailbox, never sent: local stacks have no `SES_CONFIGURATION_SET`.
