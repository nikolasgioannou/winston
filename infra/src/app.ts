import { Stack, type App } from "aws-cdk-lib";

/** Where Winston runs: the winston-prod account (docs/runbooks/aws-access.md). */
export const production = {
  account: "766577085959",
  region: "us-east-1",
  domain: "runwinston.com",
} as const;

export type Environment = typeof production;

/**
 * The stacks from docs/design.md §19, one CloudFormation stack each. They're
 * empty until the tickets that fill them; CDK skips deploying empty stacks.
 */
export function defineStacks(app: App, environment: Environment = production) {
  const env = { account: environment.account, region: environment.region };
  const stack = (id: string, description: string, stateful = false) =>
    new Stack(app, id, {
      env,
      stackName: `winston-${id.toLowerCase()}`,
      description,
      // Stateful stacks can't be deleted by accident.
      terminationProtection: stateful,
    });

  return {
    network: stack("Network", "VPC, subnets and security groups"),
    data: stack("Data", "Postgres, KMS keys and S3 buckets", true),
    services: stack(
      "Services",
      "ECS services, ECR, the load balancer and secrets",
    ),
    edge: stack("Edge", "Certificates and CloudFront"),
    vm: stack("Vm", "The user VMs' launch template and snapshots"),
    ci: stack("Ci", "GitHub's deploy role"),
    budget: stack("Budget", "Budget alerts"),
  };
}
