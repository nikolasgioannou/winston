import { describe, expect, test } from "bun:test";
import { Match, Template } from "aws-cdk-lib/assertions";
import { serviceSecrets, type Service } from "./secrets.ts";
import { agentsStopSeconds } from "./services.ts";
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
          StopTimeout?: number;
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

  test("api knows the inbound mail topic and agents the inbound mail bucket", () => {
    const names = (service: Service) =>
      (container(service).Environment ?? []).map((e) => e.Name);
    expect(names("api")).toContain("SES_INBOUND_TOPIC_ARN");
    expect(names("agents")).toContain("INBOUND_MAIL_BUCKET");
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

  test("agents gets the longest stop timeout, and most of it to finish in-flight steps", () => {
    const agents = container("agents");
    expect(agents.StopTimeout).toBe(agentsStopSeconds);
    expect(
      agents.Environment?.find(({ Name }) => Name === "SHUTDOWN_TIMEOUT_MS")
        ?.Value,
    ).toBe("110000");
    expect(container("api").StopTimeout).toBe(30);
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

  test("the gateway's internal API is never routed; only the VM websocket and live views are", () => {
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
            PathPatternConfig: { Values: ["/vm/connect", "/browser/connect"] },
          },
        ]),
      },
    );
    const all = JSON.stringify(
      template.findResources("AWS::ElasticLoadBalancingV2::ListenerRule"),
    );
    expect(all).not.toContain("/internal");
  });

  test("api, agents and the gateway may decrypt tokens; web may only seal them", () => {
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
    // The gateway opens tokens for mail and calendar calls, but never seals.
    expect(actionsFor("gateway")).toContain("kms:Decrypt");
    expect(actionsFor("gateway")).not.toContain("kms:GenerateDataKey");
    expect(actionsFor("api").some((a) => a.startsWith("s3:"))).toBe(false);
    // Blobs: agents' images, attachments and received mail; the gateway's
    // sent mail and site bundles; web's rollbacks and take-downs (§9a).
    for (const service of ["agents", "gateway", "web"] as const)
      expect(actionsFor(service)).toContain("s3:PutObject");
    // agents handles received mail and bounces it; the gateway sends his mail.
    expect(actionsFor("agents")).toContain("ses:SendBounce");
    expect(actionsFor("gateway")).toContain("ses:SendEmail");
    expect(actionsFor("gateway")).not.toContain("ses:SendBounce");
    for (const service of ["api", "web"] as const)
      expect(actionsFor(service).some((a) => a.startsWith("ses:"))).toBe(false);
  });

  test("web is reachable only with CloudFront's origin header", () => {
    template.hasResourceProperties(
      "AWS::ElasticLoadBalancingV2::ListenerRule",
      {
        Conditions: Match.arrayWith([
          {
            Field: "host-header",
            HostHeaderConfig: { Values: ["runwinston.com"] },
          },
          Match.objectLike({
            Field: "http-header",
            HttpHeaderConfig: Match.objectLike({
              HttpHeaderName: "X-Winston-Origin",
            }),
          }),
        ]),
      },
    );
  });

  test("CloudFront caches hashed assets and nothing else, forwarding cookies to web", () => {
    const { DistributionConfig: config } = Object.values(
      template.findResources("AWS::CloudFront::Distribution"),
    )[0]?.Properties as {
      DistributionConfig: {
        Aliases: string[];
        DefaultCacheBehavior: {
          CachePolicyId: string;
          OriginRequestPolicyId: string;
          ViewerProtocolPolicy: string;
        };
        CacheBehaviors: { PathPattern: string; CachePolicyId: string }[];
        Origins: {
          CustomOriginConfig: { OriginProtocolPolicy: string };
          OriginCustomHeaders: { HeaderName: string }[];
        }[];
      };
    };
    // AWS's managed policies: CachingDisabled, AllViewer, CachingOptimized.
    expect(config.Aliases).toEqual(["runwinston.com"]);
    expect(config.DefaultCacheBehavior).toMatchObject({
      CachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
      OriginRequestPolicyId: "216adef6-5c7f-47e4-b989-5492eafa07d3",
      ViewerProtocolPolicy: "redirect-to-https",
    });
    expect(
      config.CacheBehaviors.map(({ PathPattern, CachePolicyId }) => ({
        PathPattern,
        CachePolicyId,
      })),
    ).toEqual([
      {
        PathPattern: "/assets/*",
        CachePolicyId: "658327ea-f89d-4fab-a63d-7e88639e58f6",
      },
    ]);
    expect(config.Origins[0]?.CustomOriginConfig.OriginProtocolPolicy).toBe(
      "https-only",
    );
    expect(
      config.Origins[0]?.OriginCustomHeaders.map((h) => h.HeaderName),
    ).toEqual(["X-Winston-Origin"]);
  });
});
