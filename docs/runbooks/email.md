# Winston's email (`runwinston.email`)

Winston's own addresses are `<name>@runwinston.email` (ead827). The domain is apart from `runwinston.com` (the site and sign-in) and `runwinston.app` (apps Winston deploys), so a deliverability problem with his mail can't touch either. Amazon SES in `us-east-1` sends and receives for it; the `Mail` stack (`infra/src/mail.ts`) holds the SES side and the `Data` stack holds the `InboundMail` bucket. Like `runwinston.com`, the domain is registered with Cloudflare Registrar in the Winston Cloudflare account, and its DNS records are added there by hand ([dns.md](dns.md) explains why). **Every record is "DNS only"** (grey cloud).

## What the Mail stack holds

- **Sending:** an SES domain identity for `runwinston.email` with Easy DKIM (2048-bit RSA), a custom MAIL FROM domain `mail.runwinston.email` (mail bounces rather than falls back if its MX is missing), and the `Sending` configuration set, which publishes bounces, complaints and deliveries to the `SendingEvents` topic.
- **Receiving:** the `Receiving` receipt rule set with one rule for every address on the domain (not its subdomains): spam and virus scanning on, TLS required, and an S3 action writing the raw message to the `InboundMail` bucket under `inbound/<SES message id>` and notifying the `Inbound` topic. SES can only have **one active rule set per account and region**, and CloudFormation can't activate one, so a custom resource calls `setActiveReceiptRuleSet` on deploy (and clears it if the stack is deleted). Nothing else in `winston-prod` may use SES receiving.
- **Topics** sign with SHA256 (`SignatureVersion` 2), which the api verifies. Their subscriptions to `https://api.runwinston.com/webhooks/ses` come with the endpoint (9ad1b4, 201a9b).
- Classic receipt rules rather than SES Mail Manager: Mail Manager's ingress endpoint costs $50 a month before any mail, and receipt rules do everything this needs (checked 2026-10-03).

## Setting it up

1. **Buy the domain** (founder): Cloudflare dashboard → Domain Registration → Register Domains → `runwinston.email` (about $24 a year, at cost).
2. **Deploy** the `Mail` stack. It deploys with everything else (`cdk deploy --all`, [deploys.md](deploys.md)); on its own: `AWS_PROFILE=winston-prod bunx cdk deploy winston-data winston-mail` from `infra/`. The identity can exist before its records do; it verifies once they resolve.
3. **Add the records** (founder) in Cloudflare (runwinston.email → DNS → Records). The DKIM targets are the stack's outputs `Mail.DkimRecord1`–`3` (`aws cloudformation describe-stacks --stack-name winston-mail --query 'Stacks[0].Outputs'`):

   | Name                  | Type  | Content                                              | Purpose                            |
   | --------------------- | ----- | ---------------------------------------------------- | ---------------------------------- |
   | `@`                   | MX    | `inbound-smtp.us-east-1.amazonaws.com`, priority 10  | Receiving                          |
   | `<token1>._domainkey` | CNAME | `<token1>.dkim.amazonses.com`                        | DKIM (and verifies the domain)     |
   | `<token2>._domainkey` | CNAME | `<token2>.dkim.amazonses.com`                        | DKIM                               |
   | `<token3>._domainkey` | CNAME | `<token3>.dkim.amazonses.com`                        | DKIM                               |
   | `mail`                | MX    | `feedback-smtp.us-east-1.amazonses.com`, priority 10 | MAIL FROM (bounces come back here) |
   | `mail`                | TXT   | `v=spf1 include:amazonses.com ~all`                  | SPF for the MAIL FROM domain       |
   | `_dmarc`              | TXT   | `v=DMARC1; p=quarantine; adkim=r; aspf=r`            | DMARC                              |

   `mail` must have exactly that one MX and is never used as an address. DMARC starts at `quarantine` rather than `none`: the domain is new, so there's no existing mail to break, and AWS recommends a strict policy for new domains. There's no `rua` report address yet, since reports would arrive at an address no mailbox owns; add one once a mailbox for them exists.

4. **Ask AWS for production access** (founder): SES console (us-east-1) → Account dashboard → **Request production access**. Mail type **Transactional**; website `https://runwinston.com`; use case: "Each user of Winston, a personal assistant, can give their assistant an address on runwinston.email. It sends replies on threads the user involved it in and signs up for services on the user's behalf; it never sends bulk or marketing mail. Sending is limited per user per day, and bounces and complaints are received through an SNS configuration set and suppress the address." AWS answers within about a day, sometimes asking for more. Until then SES is in the **sandbox**: it can send only to verified addresses, 200 a day and 1 a second. Receiving isn't limited by the sandbox.

## Checking it

- **Verified:** SES console → Identities → `runwinston.email` shows Verified, DKIM Successful and MAIL FROM Successful; or `aws sesv2 get-email-identity --email-identity runwinston.email --profile winston-prod` (`VerifiedForSendingStatus: true`, `DkimAttributes.Status: SUCCESS`, `MailFromAttributes.MailFromDomainStatus: SUCCESS`).
- **DNS:** `dig +short MX runwinston.email`, `dig +short MX mail.runwinston.email`, `dig +short TXT mail.runwinston.email`, `dig +short TXT _dmarc.runwinston.email`, and each DKIM CNAME.
- **Receiving:** `aws ses describe-active-receipt-rule-set --profile winston-prod` names the `Receiving` set. Send a message from any address to `test@runwinston.email`; within a minute an object appears under `inbound/` in the `InboundMail` bucket (`aws s3 ls s3://<bucket>/inbound/ --profile winston-prod`), and the `Inbound` topic's delivery metrics count one notification. Delete the test object afterwards: it's someone's mail.
- **Sending:** while in the sandbox, verify your own address first (`aws sesv2 create-email-identity --email-identity you@example.com`), then `aws sesv2 send-email --from-email-address test@runwinston.email --destination ToAddresses=you@example.com --content 'Simple={Subject={Data=Test},Body={Text={Data=Hello}}}' --configuration-set-name <Sending set> --profile winston-prod`. In Gmail, **Show original** must say SPF, DKIM and DMARC **PASS**, with `mail.runwinston.email` as the SPF domain and `runwinston.email` as the DKIM one.
- **Production access:** `aws sesv2 get-account --profile winston-prod` shows `ProductionAccessEnabled: true`.

## Local development

Local stacks don't receive real mail: SES allows one active receipt rule set per account and region, and that's production's. Inbound mail is exercised locally by handing the api a raw message instead (with the inbound ticket, 9ad1b4).
