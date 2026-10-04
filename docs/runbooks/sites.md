# Sites on Cloudflare

The sites Winston deploys run on Cloudflare Workers for Platforms at `<name>.runwinston.app` (docs/design.md §9a). This is how the Cloudflare side was set up, by hand in the dashboard, on 2026-10-04. Nothing here is secret except the two tokens, which live only in the founder's password manager and Secrets Manager.

## The account

| What               | Value                                                                   |
| ------------------ | ----------------------------------------------------------------------- |
| Account            | "Ni@nikolas.ai's Account", the one that also holds `runwinston.com`     |
| Account ID         | `137b768c2abe11d311f8a0f73e7a2be3`                                      |
| Plan               | Workers for Platforms Paid ($25/month; includes Workers Paid and D1)    |
| Dispatch namespace | `winston-sites`: every site's Worker, named by its id (`site_…`)        |
| Routes map         | Workers KV `winston-site-routes`, id `185e3de3dc1a43a78b3687b3a1ce2e47` |

## The domain

`runwinston.app`, registered with Cloudflare Registrar in the same account, DNS on Cloudflare. A separate domain from `runwinston.com`, so sites never share cookies or reputation with the site (§9a).

| Name | Type | Target  | Proxied | Purpose                                                                              |
| ---- | ---- | ------- | ------- | ------------------------------------------------------------------------------------ |
| `*`  | AAAA | `100::` | Yes     | Sends every `<name>.runwinston.app` to Cloudflare, where the dispatch Worker answers |

`100::` is a placeholder (the discard prefix): the proxy never forwards to it. Cloudflare's Universal SSL certificate covers `*.runwinston.app`.

## Tokens

Account API tokens (Manage Account → Account API Tokens), with no expiry and no IP filtering: the backend's Fargate tasks and GitHub's runners have no fixed addresses.

| Token              | Policies                                                                                                               | Used by                           |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `winston-backend`  | Entire account: Workers Scripts (Legacy) Edit, D1 Edit, Workers KV Storage Edit, Account Analytics Read                | gateway and agents                |
| `winston-ci-sites` | Entire account: Workers Scripts (Legacy) Edit, Account Settings Read. `runwinston.app`: Workers Routes Edit, Zone Read | CI, deploying the dispatch Worker |

**Workers Scripts is the legacy permission on purpose.** Cloudflare's newer Workers roles (Editor, Admin) don't yet say whether they cover dispatch namespaces, and Editor can't create or delete Workers, which every new or removed site needs. Legacy permissions have no deprecation date. Move to the new roles once Cloudflare documents them for Workers for Platforms.

`winston-backend` lives in Secrets Manager as `winston/cloudflare-api-token` (`bun run prod:keys` sets it); `winston-ci-sites` is the GitHub Actions secret `CLOUDFLARE_SITES_CI_TOKEN`.

**Rotating one** (a leak, or someone leaving): create a replacement with the same policies, store it, restart the services that read it, then delete the old one in the dashboard.

## The kill switch

To take every site offline at once (abuse, a runaway bill, an incident):

```bash
bun run sites:switch pause-all
```

Every running site shows its paused page and Winston tells each user. `resume-all` brings them back, leaving sites paused for a cap alone. That's the dev stack; in production:

```bash
bun run prod sites pause-all
```

It queues a `switch_sites` job, which agents runs (it holds the Cloudflare token); agents' logs say how many sites it switched.

## Going live

Once, in this order:

1. Merge and deploy (`gh workflow run ci.yml`, docs/runbooks/deploys.md). The CDK deploy creates `winston/sites-pass-key` (generated) and `winston/cloudflare-api-token` (a placeholder), and gives the services the Cloudflare settings. Until step 2, deploying a site fails with Cloudflare's authentication error.
2. `bun run prod:keys`: paste the `winston-backend` token at its prompt (leave the others blank). It restarts the services that read it.
3. Add the CI token: `gh secret set CLOUDFLARE_SITES_CI_TOKEN` and paste `winston-ci-sites`.
4. Deploy the dispatch Worker: run the CI workflow again, or from a laptop `CLOUDFLARE_API_TOKEN=<ci token> bun run sites:deploy-dispatch` (with `aws sso login --profile winston-prod`). It reads `winston/sites-pass-key`, derives its public half, and runs `wrangler deploy` (`apps/sites/wrangler.jsonc`) on `*.runwinston.app/*`.
5. Check: `https://anything.runwinston.app` answers "No site here"; ask Winston for a small site, open it signed in, and in a private window see the sign-in redirect.

Two details to confirm on the first real run (the docs were unclear): the analytics field for total CPU (`sum { cpuTimeUs }`; an introspection query settles it) and whether D1's REST `batch` is one transaction.

## Billing

The account's budget alert (Notifications → "Default budget alert") emails the founder past **$40 a month**: the $25 plan plus headroom, so it fires only when sites use more than the plan includes. Per-site and per-user caps pause sites well before that (0a3197).
