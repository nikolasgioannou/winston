import { describe, test } from "bun:test";
import { Match, Template } from "aws-cdk-lib/assertions";
import { testApp } from "./testing.ts";

describe("budget stack", () => {
  const { stacks } = testApp();
  const template = Template.fromStack(stacks.budget);

  test("alerts on $150 actual and $200 forecast a month, by email", () => {
    template.hasResourceProperties("AWS::Budgets::Budget", {
      Budget: Match.objectLike({
        BudgetType: "COST",
        TimeUnit: "MONTHLY",
        BudgetLimit: { Amount: 150, Unit: "USD" },
      }),
      NotificationsWithSubscribers: [
        Match.objectLike({
          Notification: {
            NotificationType: "ACTUAL",
            ComparisonOperator: "GREATER_THAN",
            Threshold: 150,
            ThresholdType: "ABSOLUTE_VALUE",
          },
          Subscribers: [Match.objectLike({ SubscriptionType: "EMAIL" })],
        }),
        Match.objectLike({
          Notification: {
            NotificationType: "FORECASTED",
            ComparisonOperator: "GREATER_THAN",
            Threshold: 200,
            ThresholdType: "ABSOLUTE_VALUE",
          },
        }),
      ],
    });
  });
});
