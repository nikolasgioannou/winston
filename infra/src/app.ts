import type { App } from "aws-cdk-lib";
import { BudgetStack } from "./budget.ts";
import { CiStack } from "./ci.ts";
import { DataStack } from "./data.ts";
import { EdgeStack } from "./edge.ts";
import { MailStack } from "./mail.ts";
import { NetworkStack } from "./network.ts";
import { ServicesStack } from "./services.ts";
import { VmStack } from "./vm.ts";

/** Where Winston runs: the winston-prod account (docs/runbooks/aws-access.md). */
export const production = {
  account: "766577085959",
  region: "us-east-1",
  domain: "runwinston.com",
  /** Winston's own addresses (ead827), apart from the site's domain. */
  mailDomain: "runwinston.email",
} as const;

export type Environment = typeof production;

/**
 * The stacks from docs/design.md §19, one CloudFormation stack each.
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
      agents: 1,
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

  const mail = new MailStack(app, "Mail", {
    ...props("Mail", "Winston's own mail: SES sending and receiving"),
    mailDomain: environment.mailDomain,
    inboundMail: data.inboundMail,
  });

  return {
    network,
    data,
    services,
    edge,
    vm,
    ci,
    budget: new BudgetStack(app, "Budget", props("Budget", "Budget alerts")),
    mail,
  };
}
