# DNS and certificates

`runwinston.com` is registered with Cloudflare Registrar and its DNS is on Cloudflare, not Route 53 (docs/design.md §8). CDK never creates DNS records: certificates are validated, and endpoints published, by records added by hand in the Cloudflare dashboard (runwinston.com → DNS → Records). The founder chose by hand over a script with a Cloudflare API token: there are only a few records and they rarely change.

**Every AWS record is "DNS only"** (grey cloud), never proxied. ACM can't validate through Cloudflare's proxy, and TLS terminates at CloudFront and the load balancer with the ACM certificate, not at Cloudflare.

## Records

| Name                                        | Type   | Target                                                             | Purpose                                  |
| ------------------------------------------- | ------ | ------------------------------------------------------------------ | ---------------------------------------- |
| `dev`                                       | Tunnel | `winston-dev`                                                      | Local webhooks (docs/local-dev.md)       |
| `_0bc883f712ebe7d31ca9401ad9431f37`         | CNAME  | `_d84ad138c35ca0294ba403d0cb518f83.wzccmgtwzk.acm-validations.aws` | Certificate validation: `runwinston.com` |
| `_e358564c4f5f78b8ce5318447b53f6d8.api`     | CNAME  | `_6c19bf7bbd9eca98dcfb56f1895ce51d.wzccmgtwzk.acm-validations.aws` | Certificate validation: `api.`           |
| `_176fb5a42629f4986c0bfb0d4efdfb6c.gateway` | CNAME  | `_94f402c9f66e494c6b02ffbe85c51019.wzccmgtwzk.acm-validations.aws` | Certificate validation: `gateway.`       |

The validation records stay forever: ACM renews the certificate automatically only while they resolve.

**To add when the stacks exist** (each stack outputs its target):

| Name      | Type  | Target                                        | Added by              |
| --------- | ----- | --------------------------------------------- | --------------------- |
| `@`       | CNAME | the CloudFront distribution's domain (`Edge`) | the CloudFront ticket |
| `api`     | CNAME | the load balancer's DNS name (`Services`)     | the Fargate ticket    |
| `gateway` | CNAME | the load balancer's DNS name (`Services`)     | the Fargate ticket    |

Cloudflare flattens a CNAME at the apex, so `@` can point at CloudFront. When a record is added, move it into the table above.

## Certificate

One ACM certificate in `us-east-1` (the `Edge` stack) covers `runwinston.com`, `api.runwinston.com` and `gateway.runwinston.com`. CloudFront requires `us-east-1`, which is also where the load balancer runs, so both use it. Issued 2026-10-01.

A new name means changing the certificate in `infra/src/edge.ts`. CloudFormation then requests a replacement certificate and waits (up to a few hours) for its validation records:

1. Start the deploy: `AWS_PROFILE=winston-prod bun run infra:deploy`.
2. While it waits, read the new records:
   ```sh
   aws acm list-certificates --certificate-statuses PENDING_VALIDATION --profile winston-prod
   aws acm describe-certificate --certificate-arn <arn> --query 'Certificate.DomainValidationOptions[].ResourceRecord' --profile winston-prod
   ```
3. Add them in Cloudflare (CNAME, DNS only; drop the trailing dot and the `.runwinston.com` suffix from the name), and update the table here.

## Checking

```sh
dig +short CNAME _0bc883f712ebe7d31ca9401ad9431f37.runwinston.com @1.1.1.1
aws acm list-certificates --profile winston-prod   # Status: ISSUED
```
