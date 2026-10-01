import { Stack, type StackProps } from "aws-cdk-lib";
import {
  GatewayVpcEndpointAwsService,
  Peer,
  Port,
  SecurityGroup,
  SubnetType,
  Vpc,
} from "aws-cdk-lib/aws-ec2";
import type { Construct } from "constructs";

/** The ports services listen on, the same as local development. */
export const servicePorts = { api: 3000, gateway: 3001, web: 3002 } as const;

const postgresPort = 5432;

/**
 * The VPC and the security groups every other stack uses (docs/design.md §19).
 * No NAT gateway: Fargate tasks and VMs sit in public subnets with public IPs,
 * and RDS sits in isolated subnets with no internet route.
 */
export class NetworkStack extends Stack {
  readonly vpc: Vpc;
  readonly securityGroups: {
    alb: SecurityGroup;
    api: SecurityGroup;
    web: SecurityGroup;
    gateway: SecurityGroup;
    agents: SecurityGroup;
    database: SecurityGroup;
    vm: SecurityGroup;
  };

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    this.vpc = new Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: "public", subnetType: SubnetType.PUBLIC, cidrMask: 24 },
        {
          name: "isolated",
          subnetType: SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
      // Free, and keeps S3 traffic (binaries, blobs) on AWS's network.
      gatewayEndpoints: { s3: { service: GatewayVpcEndpointAwsService.S3 } },
    });

    const group = (name: string, description: string, outbound = true) =>
      new SecurityGroup(this, name, {
        vpc: this.vpc,
        description,
        allowAllOutbound: outbound,
      });

    const alb = group("Alb", "The load balancer: HTTPS from anywhere");
    alb.addIngressRule(Peer.anyIpv4(), Port.tcp(443), "HTTPS");
    alb.addIngressRule(Peer.anyIpv6(), Port.tcp(443), "HTTPS");

    const api = group("Api", "api: from the load balancer");
    api.addIngressRule(
      alb,
      Port.tcp(servicePorts.api),
      "From the load balancer",
    );
    const web = group("Web", "web: from the load balancer");
    web.addIngressRule(
      alb,
      Port.tcp(servicePorts.web),
      "From the load balancer",
    );
    const agents = group("Agents", "agents: no inbound traffic");
    const gateway = group(
      "Gateway",
      "gateway: VM websockets through the load balancer, its internal API from agents",
    );
    gateway.addIngressRule(
      alb,
      Port.tcp(servicePorts.gateway),
      "VM websockets from the load balancer",
    );
    gateway.addIngressRule(
      agents,
      Port.tcp(servicePorts.gateway),
      "Internal API from agents",
    );

    const database = group("Database", "Postgres: from the services", false);
    for (const [name, service] of Object.entries({ api, web, gateway, agents }))
      database.addIngressRule(service, Port.tcp(postgresPort), `From ${name}`);

    // winstond only connects out (docs/design.md §10).
    const vm = group("Vm", "User VMs: no inbound traffic");

    this.securityGroups = { alb, api, web, gateway, agents, database, vm };
  }
}
