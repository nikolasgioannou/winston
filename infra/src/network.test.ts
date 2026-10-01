import { describe, expect, test } from "bun:test";
import { Template } from "aws-cdk-lib/assertions";
import { testApp } from "./testing.ts";

describe("network stack", () => {
  const { stacks } = testApp();
  const network = stacks.network;
  const template = Template.fromStack(network);
  const groupId = (group: keyof typeof network.securityGroups) =>
    network.resolve(network.securityGroups[group].securityGroupId) as unknown;

  /** Every ingress rule, inline or separate, as port and source. */
  const ingress = (group: keyof typeof network.securityGroups) => {
    const id = groupId(group);
    const rules: { port: unknown; source: unknown }[] = [];
    const groups = template.findResources("AWS::EC2::SecurityGroup");
    for (const [logicalId, resource] of Object.entries(groups)) {
      if (!isRef(id, logicalId)) continue;
      const properties = resource.Properties as {
        SecurityGroupIngress?: {
          FromPort: number;
          CidrIp?: string;
          CidrIpv6?: string;
        }[];
      };
      const inline = properties.SecurityGroupIngress ?? [];
      for (const rule of inline)
        rules.push({
          port: rule.FromPort,
          source: rule.CidrIp ?? rule.CidrIpv6,
        });
    }
    const separate = template.findResources("AWS::EC2::SecurityGroupIngress");
    for (const resource of Object.values(separate)) {
      const properties = resource.Properties as {
        GroupId: unknown;
        FromPort: number;
        SourceSecurityGroupId: unknown;
      };
      if (JSON.stringify(properties.GroupId) !== JSON.stringify(id)) continue;
      rules.push({
        port: properties.FromPort,
        source: properties.SourceSecurityGroupId,
      });
    }
    return rules;
  };

  test("has no NAT gateway, so nothing bills by the hour or the gigabyte", () => {
    template.resourceCountIs("AWS::EC2::NatGateway", 0);
  });

  test("spans two availability zones with public and isolated subnets", () => {
    expect(network.vpc.publicSubnets).toHaveLength(2);
    expect(network.vpc.isolatedSubnets).toHaveLength(2);
    expect(network.vpc.privateSubnets).toHaveLength(0);
    template.resourceCountIs("AWS::EC2::VPCEndpoint", 1);
  });

  test("user VMs accept no inbound traffic at all", () => {
    expect(ingress("vm")).toEqual([]);
  });

  test("agents accept no inbound traffic", () => {
    expect(ingress("agents")).toEqual([]);
  });

  test("Postgres is reachable only from the services, on 5432", () => {
    expect(ingress("database")).toEqual(
      (["api", "web", "gateway", "agents"] as const).map((service) => ({
        port: 5432,
        source: groupId(service),
      })),
    );
  });

  test("Postgres has no route to the internet", () => {
    for (const subnet of network.vpc.isolatedSubnets) {
      const routes = template.findResources("AWS::EC2::Route", {
        Properties: {
          RouteTableId: network.resolve(
            subnet.routeTable.routeTableId,
          ) as unknown,
        },
      });
      expect(Object.keys(routes)).toEqual([]);
    }
  });

  test("services accept traffic only from the load balancer, and the gateway from agents", () => {
    expect(ingress("api")).toEqual([{ port: 3000, source: groupId("alb") }]);
    expect(ingress("web")).toEqual([{ port: 3002, source: groupId("alb") }]);
    expect(ingress("gateway")).toEqual([
      { port: 3001, source: groupId("alb") },
      { port: 3001, source: groupId("agents") },
    ]);
  });

  test("the load balancer accepts only HTTPS", () => {
    expect(ingress("alb")).toEqual([
      { port: 443, source: "0.0.0.0/0" },
      { port: 443, source: "::/0" },
    ]);
  });
});

function isRef(id: unknown, logicalId: string) {
  const ref = id as { "Fn::GetAtt"?: [string, string] };
  return ref["Fn::GetAtt"]?.[0] === logicalId;
}
