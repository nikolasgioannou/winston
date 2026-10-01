import { describe, expect, test } from "bun:test";
import { Match, Template } from "aws-cdk-lib/assertions";
import { serviceSecrets, type Service } from "./secrets.ts";
import { testApp } from "./testing.ts";

describe("services stack", () => {
  const { stacks } = testApp();
  const services = stacks.services;
  const template = Template.fromStack(services);

  /** A service's container definition, as synthesized. */
  const container = (service: Service) => {
    const definitions = template.findResources("AWS::ECS::TaskDefinition");
    const logicalId = services.getLogicalId(
      services.taskDefinitions[service].node.defaultChild as never,
    );
    const definition = definitions[logicalId] as {
      Properties: {
        ContainerDefinitions: {
          Secrets?: { Name: string; ValueFrom: unknown }[];
          Environment?: { Name: string; Value: unknown }[];
        }[];
      };
    };
    const [first] = definition.Properties.ContainerDefinitions;
    if (!first) throw new Error(`No container for ${service}`);
    return first;
  };

  test("each task gets exactly the secrets serviceSecrets gives it", () => {
    for (const service of Object.keys(serviceSecrets) as Service[]) {
      const names = (container(service).Secrets ?? []).map(({ Name }) => Name);
      expect(names.sort()).toEqual(Object.keys(serviceSecrets[service]).sort());
    }
  });

  test("tasks get the database secret's ARN, never a password", () => {
    for (const service of Object.keys(serviceSecrets) as Service[]) {
      const environment = container(service).Environment ?? [];
      const names = environment.map(({ Name }) => Name);
      expect(names).toContain("DATABASE_SECRET_ARN");
      const url = environment.find(({ Name }) => Name === "DATABASE_URL");
      expect(JSON.stringify(url?.Value)).toContain("postgres://postgres@");
      expect(JSON.stringify(url?.Value)).not.toContain("postgres:postgres@");
    }
  });

  test("every service rolls back a failing deployment", () => {
    template.resourceCountIs("AWS::ECS::Service", 4);
    template.allResourcesProperties("AWS::ECS::Service", {
      DeploymentConfiguration: Match.objectLike({
        DeploymentCircuitBreaker: { Enable: true, Rollback: true },
      }),
    });
  });

  test("services run on ARM64 in public subnets with public IPs", () => {
    template.allResourcesProperties("AWS::ECS::TaskDefinition", {
      RuntimePlatform: { CpuArchitecture: "ARM64" },
    });
    template.allResourcesProperties("AWS::ECS::Service", {
      NetworkConfiguration: {
        AwsvpcConfiguration: Match.objectLike({ AssignPublicIp: "ENABLED" }),
      },
    });
  });

  test("the load balancer listens only on HTTPS and routes only known hosts", () => {
    template.resourceCountIs("AWS::ElasticLoadBalancingV2::Listener", 1);
    template.hasResourceProperties("AWS::ElasticLoadBalancingV2::Listener", {
      Port: 443,
      Protocol: "HTTPS",
      DefaultActions: [Match.objectLike({ Type: "fixed-response" })],
    });
    const rules = Object.values(
      template.findResources("AWS::ElasticLoadBalancingV2::ListenerRule"),
    ).map(
      (rule) =>
        (
          rule.Properties as {
            Conditions: { Field: string; Values?: string[] }[];
          }
        ).Conditions,
    );
    expect(rules).toHaveLength(3);
  });

  test("the gateway's internal API is never routed; only the VM websocket is", () => {
    template.hasResourceProperties(
      "AWS::ElasticLoadBalancingV2::ListenerRule",
      {
        Conditions: Match.arrayWith([
          {
            Field: "host-header",
            HostHeaderConfig: { Values: ["gateway.runwinston.com"] },
          },
          {
            Field: "path-pattern",
            PathPatternConfig: { Values: ["/vm/connect"] },
          },
        ]),
      },
    );
    const all = JSON.stringify(
      template.findResources("AWS::ElasticLoadBalancingV2::ListenerRule"),
    );
    expect(all).not.toContain("/internal");
  });

  test("only api and agents may decrypt tokens; web may only seal them", () => {
    const policies = template.findResources("AWS::IAM::Policy");
    const actionsFor = (service: Service) => {
      const role = services.resolve(
        services.taskDefinitions[service].taskRole.roleName,
      ) as unknown;
      const actions: string[] = [];
      for (const policy of Object.values(policies)) {
        const properties = policy.Properties as {
          Roles: unknown[];
          PolicyDocument: { Statement: { Action: string | string[] }[] };
        };
        if (
          !properties.Roles.some(
            (r) => JSON.stringify(r) === JSON.stringify(role),
          )
        )
          continue;
        for (const statement of properties.PolicyDocument.Statement)
          actions.push(...[statement.Action].flat());
      }
      return actions;
    };
    for (const service of ["api", "agents"] as const)
      expect(actionsFor(service)).toContain("kms:Decrypt");
    expect(actionsFor("web")).toContain("kms:GenerateDataKey");
    expect(actionsFor("web")).not.toContain("kms:Decrypt");
    expect(actionsFor("gateway").some((a) => a.startsWith("kms:"))).toBe(false);
    for (const service of ["api", "gateway", "web"] as const)
      expect(actionsFor(service).some((a) => a.startsWith("s3:"))).toBe(false);
    expect(actionsFor("agents")).toContain("s3:PutObject");
  });
});
