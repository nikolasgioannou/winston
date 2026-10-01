import { Stack, type App } from "aws-cdk-lib";
import { CiStack } from "./ci.ts";
import { DataStack } from "./data.ts";
import { EdgeStack } from "./edge.ts";
import { NetworkStack } from "./network.ts";
import { ServicesStack } from "./services.ts";
import { VmStack } from "./vm.ts";

/** Where Winston runs: the winston-prod account (docs/runbooks/aws-access.md). */
export const production = {
  account: "766577085959",
  region: "us-east-1",
  domain: "runwinston.com",
} as const;

export type Environment = typeof production;

/**
 * The stacks from docs/design.md §19, one CloudFormation stack each. A stack is
 * empty until the ticket that fills it; CDK skips deploying empty stacks.
 */
export function defineStacks(app: App, environment: Environment = production) {
  const env = { account: environment.account, region: environment.region };
  const props = (id: string, description: string, stateful = false) => ({
    env,
    stackName: `winston-${id.toLowerCase()}`,
    description,
    // Stateful stacks can't be deleted by accident.
    terminationProtection: stateful,
  });
  const stack = (id: string, description: string, stateful = false) =>
    new Stack(app, id, props(id, description, stateful));

  const network = new NetworkStack(
    app,
    "Network",
    props("Network", "VPC, subnets and security groups"),
  );
  const data = new DataStack(app, "Data", {
    ...props("Data", "Postgres, KMS keys and S3 buckets", true),
    vpc: network.vpc,
    databaseSecurityGroup: network.securityGroups.database,
  });

  const edge = new EdgeStack(app, "Edge", {
    ...props("Edge", "Certificates"),
    domain: environment.domain,
  });
  const ci = new CiStack(app, "Ci", {
    ...props("Ci", "Image repositories and GitHub's deploy roles"),
    artifacts: data.artifacts,
    signingKey: data.signingKey,
  });
  const vm = new VmStack(app, "Vm", {
    ...props("Vm", "The user VMs' launch template, permissions and snapshots"),
    vmSecurityGroup: network.securityGroups.vm,
  });
  const services = new ServicesStack(app, "Services", {
    ...props(
      "Services",
      "ECS services, the load balancer, CloudFront and secrets",
    ),
    domain: environment.domain,
    desiredCounts: {
      gateway: 1,
      api: 1,
      web: 1,
      // Stopped until the EC2 VM provider replaces local Docker (550446).
      agents: 0,
    },
    vpc: network.vpc,
    securityGroups: network.securityGroups,
    repositories: ci.repositories,
    certificate: edge.certificate,
    database: {
      endpoint: data.database.dbInstanceEndpointAddress,
      port: data.database.dbInstanceEndpointPort,
      secretArn: data.databaseSecretArn,
    },
    tokensKey: data.tokensKey,
    blobs: data.blobs,
    artifacts: data.artifacts,
    vm: {
      backendPolicy: vm.backendPolicy,
      launchTemplateName: "winston-vm",
      subnetIds: network.vpc.publicSubnets.map((subnet) => subnet.subnetId),
    },
  });

  return {
    network,
    data,
    services,
    edge,
    vm,
    ci,
    budget: stack("Budget", "Budget alerts"),
  };
}
