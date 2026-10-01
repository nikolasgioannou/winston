import { Stack, type StackProps } from "aws-cdk-lib";
import { CfnBudget } from "aws-cdk-lib/aws-budgets";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";

/**
 * Where budget alerts go: an SSM parameter, set by hand, so the founder's
 * address stays out of this public repository (docs/runbooks/costs.md).
 */
export const alertEmailParameter = "/winston/alert-email";

/** The monthly alerts (docs/design.md §8): the one-user baseline is ~$120. */
export const budgetAlerts = { actualUsd: 150, forecastUsd: 200 } as const;

/**
 * AWS Budgets alerts for winston-prod (docs/design.md §8, Account isolation).
 * Model spend isn't here: OpenRouter bills it, with its own limits.
 */
export class BudgetStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    // Resolved by CloudFormation at each deploy.
    const email = StringParameter.valueForStringParameter(
      this,
      alertEmailParameter,
    );
    const alert = (
      notificationType: "ACTUAL" | "FORECASTED",
      amount: number,
    ): CfnBudget.NotificationWithSubscribersProperty => ({
      notification: {
        notificationType,
        comparisonOperator: "GREATER_THAN",
        threshold: amount,
        thresholdType: "ABSOLUTE_VALUE",
      },
      subscribers: [{ subscriptionType: "EMAIL", address: email }],
    });

    new CfnBudget(this, "Monthly", {
      budget: {
        budgetName: "winston-monthly",
        budgetType: "COST",
        timeUnit: "MONTHLY",
        budgetLimit: { amount: budgetAlerts.actualUsd, unit: "USD" },
      },
      notificationsWithSubscribers: [
        // Spending has passed $150 this month.
        alert("ACTUAL", budgetAlerts.actualUsd),
        // The month is on course to pass $200.
        alert("FORECASTED", budgetAlerts.forecastUsd),
      ],
    });
  }
}
