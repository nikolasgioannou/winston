# Costs and spend alerts

Winston's money goes to two places: AWS (everything that runs) and OpenRouter (the models). Each has its own alerts, so abnormal spending shows up in email either way (docs/design.md §8).

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

**Where the money goes:** Cost Explorer in the Billing console, grouped by service. Per-user costs (model tokens, VM hours) are recorded in the database (§8).

## OpenRouter (models)

Models are billed by OpenRouter, not AWS, so the AWS budget never sees them. Set these on the OpenRouter account that owns the production key ([notification docs](https://openrouter.ai/docs/projects/docs/guides/features/notifications)):

1. **A credit limit on the production key:** Settings → API Keys → open the production key → set a **credit limit** (a monthly ceiling that's comfortably above normal use; requests fail with 402 once it's reached, which is better than an open-ended bill). Then, under the key's Notifications, turn on the **spend limit alert** (80% and 100% by default).
2. **A low-balance alert for the account:** Settings → Notifications → **Low balance** → set the amount (default $100) and who gets it. It fires once when the balance drops below it.
3. Keep the dev key separate with its own small limit, so local experiments never eat into production's.

When an OpenRouter limit is reached, Winston's model calls fail with a clear error in the logs and the model-call log; raise the limit or top up, nothing else needs to change.

## TypeSafe (Jev)

Jev isn't wired into Winston yet (M8). When it is, set the same two things on its account if it offers them (a spending cap and a low-balance alert), and add them here.
