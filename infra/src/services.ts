import { Stack, type StackProps } from "aws-cdk-lib";
import type { Construct } from "constructs";
import { Secrets } from "./secrets.ts";

/**
 * The backend services (docs/design.md §19). For now, their secrets; the
 * cluster, services and load balancer come with the Fargate ticket.
 */
export class ServicesStack extends Stack {
  readonly secrets: Secrets;

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);
    this.secrets = new Secrets(this, "Secrets");
  }
}
