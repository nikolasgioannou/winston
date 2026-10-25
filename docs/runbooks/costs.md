# Costs and spend alerts

Winston's money goes to two places: AWS (everything that runs) and OpenRouter (the models). Each has its own alerts, so abnormal spending shows up in email either way (docs/design.md §8).

## While paused (since 2026-10-25)

Production is paused ([pause.md](pause.md)). Nothing runs, so AWS costs about $2–3 a month (the two KMS keys, the snapshots, S3 and ECR) and the models nothing. Cloudflare's $25 plan is cancelled by hand, which leaves the domains (about $49 a year).

**Measured before the pause, for one user:**

- **AWS:** $4.29 a day, about $130 a month: Fargate $36, the VM $27, seven public IPv4 addresses $26 (four services, two for the load balancer, the VM), the load balancer $16, RDS $14, the rest $10. That's above the ~$120 estimate below, because the VM ran on demand with no Savings Plan and there were more public addresses than estimated.
- **Models:** $2.50–3.50 a day after launch week ($12–18 a day while testing), about 60% of it front of house. More than half of the front of house's spend was turns that rewrote its whole cache after an hour's gap.

## AWS

The `Budget` stack (`infra/src/budget.ts`) keeps one AWS Budget for `winston-prod`, `winston-monthly`:

| Alert    | When                                     |
| -------- | ---------------------------------------- |
| Actual   | this month's costs pass **$150**         |
| Forecast | this month is on course to pass **$200** |

The one-user baseline is about $120 a month, so lower thresholds would fire every month. Budgets update a few times a day, so an alert can lag spending by hours. The first two budgets in an account are free.

**Who gets them:** the address in the SSM parameter `/winston/alert-email`, read at deploy time so it stays out of this public repository. To change it:

```sh
aws ssm put-parameter --name /winston/alert-email --type String --value someone@example.com --overwrite --profile winston-prod
AWS_PROFILE=winston-prod bun run infra:deploy
```

AWS asks nothing to confirm a budget email address; check the alerts land by watching for the first one, or look at the budget in the Billing console (sign in to `winston-prod` through the access portal).

**Where the money goes:** Cost Explorer in the Billing console, grouped by service. Per-user costs (model tokens, Jev, transcription, VM hours) are recorded in the database (§8), and read with:

```sh
bun run prod costs                                   # everyone, this month
bun run prod costs --user someone@example.com --month 2026-10
```

It prints spend by category, model spend by agent (front of house or background) and by what started the run, and the ten most expensive runs. `bun run costs` does the same on the local database.

## OpenRouter (models)

Models are billed by OpenRouter, not AWS, so the AWS budget never sees them. Set these on the OpenRouter account that owns the production key ([notification docs](https://openrouter.ai/docs/projects/docs/guides/features/notifications)):

1. **A credit limit on the production key:** Settings → API Keys → open the production key → set a **credit limit** (a monthly ceiling that's comfortably above normal use; requests fail with 402 once it's reached, which is better than an open-ended bill). Then, under the key's Notifications, turn on the **spend limit alert** (80% and 100% by default).
2. **A low-balance alert for the account:** Settings → Notifications → **Low balance** → set the amount (default $100) and who gets it. It fires once when the balance drops below it.
3. Keep the dev key separate with its own small limit, so local experiments never eat into production's.

**Current state (2026-10-02):** the production key has a monthly credit limit, and the dev key a raised one; the email alerts (1 and 2) are deliberately off for now (the founder's call).

When an OpenRouter limit is reached, Winston's model calls fail with a clear error in the logs and the model-call log; raise the limit or top up, nothing else needs to change.

## Jev

Jev and its helpers (the models behind the browser's `act`) are served by OpenRouter and billed to the same key, so the OpenRouter limit covers it; there's no separate TypeSafe account. Its calls show as `jev` in `bun run prod costs` (fractions of a cent each).
