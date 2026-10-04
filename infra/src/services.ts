import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
} from "aws-cdk-lib";
import type { ICertificate } from "aws-cdk-lib/aws-certificatemanager";
import {
  AllowedMethods,
  CachePolicy,
  Distribution,
  HttpVersion,
  OriginProtocolPolicy,
  OriginRequestPolicy,
  PriceClass,
  SecurityPolicyProtocol,
  ViewerProtocolPolicy,
} from "aws-cdk-lib/aws-cloudfront";
import { LoadBalancerV2Origin } from "aws-cdk-lib/aws-cloudfront-origins";
import {
  SubnetType,
  type ISecurityGroup,
  type IVpc,
} from "aws-cdk-lib/aws-ec2";
import type { IRepository } from "aws-cdk-lib/aws-ecr";
import {
  Cluster,
  ContainerImage,
  CpuArchitecture,
  FargateService,
  FargateTaskDefinition,
  LogDrivers,
  OperatingSystemFamily,
} from "aws-cdk-lib/aws-ecs";
import {
  ApplicationLoadBalancer,
  ApplicationProtocol,
  ApplicationTargetGroup,
  ListenerAction,
  ListenerCondition,
  SslPolicy,
  TargetType,
} from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { PolicyStatement, type IManagedPolicy } from "aws-cdk-lib/aws-iam";
import type { IKey } from "aws-cdk-lib/aws-kms";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import type { IBucket } from "aws-cdk-lib/aws-s3";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";
import { servicePorts } from "./network.ts";
import { Secrets, type Service } from "./secrets.ts";

/** The SSM parameter naming the image tag (a commit SHA) every service runs. */
export const imageTagParameter = "/winston/image-tag";

/** CloudFront sends it to the load balancer; requests without it don't reach web. */
export const originHeader = "X-Winston-Origin";

/** Fargate task sizes (CPU units, MiB), on ARM64 (docs/design.md §19). */
const sizes: Record<Service, { cpu: number; memoryMiB: number }> = {
  api: { cpu: 256, memoryMiB: 512 },
  gateway: { cpu: 256, memoryMiB: 512 },
  web: { cpu: 256, memoryMiB: 512 },
  // Runs agent loops and the job queue; the busiest service.
  agents: { cpu: 512, memoryMiB: 1024 },
};

/** Winston's Google Cloud project (docs/runbooks/google-cloud.md, infra/gcp). */
export const gcpProject = "winston-510100";

/** How long agents gets after SIGTERM before it's killed: Fargate's maximum. */
export const agentsStopSeconds = 120;

export interface ServicesStackProps extends StackProps {
  domain: string;
  /** How many tasks each service runs; 0 keeps a service defined but stopped. */
  desiredCounts: Record<Service, number>;
  vpc: IVpc;
  securityGroups: Record<Service | "alb" | "ops", ISecurityGroup>;
  repositories: Record<Service | "ops", IRepository>;
  certificate: ICertificate;
  database: { endpoint: string; port: string; secretArn: string };
  tokensKey: IKey;
  blobs: IBucket;
  /** VM binaries; the gateway presigns downloads from it. */
  artifacts: IBucket;
  /** Winston's own mail (the Mail stack): where it arrives, and SES's identity. */
  mail: {
    inboundBucket: IBucket;
    inboundTopicArn: string;
    eventsTopicArn: string;
    identityArn: string;
    configurationSetName: string;
  };
  /** What agents needs to run users' VMs on EC2 (the Vm stack). */
  vm: {
    backendPolicy: IManagedPolicy;
    launchTemplateName: string;
    subnetIds: string[];
  };
}

/**
 * The four backend services on Fargate behind one load balancer, with their
 * secrets, and CloudFront in front of web (docs/design.md §9, §19).
 */
export class ServicesStack extends Stack {
  readonly secrets: Secrets;
  readonly cluster: Cluster;
  readonly loadBalancer: ApplicationLoadBalancer;
  readonly services: Record<Service, FargateService>;
  readonly taskDefinitions: Record<Service, FargateTaskDefinition>;
  readonly distribution: Distribution;
  /** One-off production tasks: migrations and admin commands. */
  readonly opsTaskDefinition: FargateTaskDefinition;

  constructor(scope: Construct, id: string, props: ServicesStackProps) {
    super(scope, id, props);
    const { domain } = props;
    this.secrets = new Secrets(this, "Secrets");

    this.cluster = new Cluster(this, "Cluster", { vpc: props.vpc });
    // Private DNS for service-to-service calls: agents reaches the gateway's
    // internal API at gateway.winston.internal, never through the load balancer.
    this.cluster.addDefaultCloudMapNamespace({ name: "winston.internal" });

    // Resolved by CloudFormation at each deploy, so a deploy that only sets
    // the parameter rolls out new images (docs/runbooks/deploys.md).
    const imageTag = StringParameter.valueForStringParameter(
      this,
      imageTagParameter,
    );
    const databaseSecret = Secret.fromSecretCompleteArn(
      this,
      "DatabaseSecret",
      props.database.secretArn,
    );
    const databaseUrl = `postgres://postgres@${props.database.endpoint}:${props.database.port}/winston`;
    const publicUrl = `https://${domain}`;

    const environment: Record<Service, Record<string, string>> = {
      api: {
        API_HOST: "0.0.0.0",
        API_PORT: String(servicePorts.api),
        // Gmail push (infra/gcp/prod): the audience and signer Pub/Sub uses.
        GMAIL_PUSH_AUDIENCE: `https://api.${domain}/webhooks/gmail`,
        GMAIL_PUSH_SERVICE_ACCOUNT: `gmail-push@${gcpProject}.iam.gserviceaccount.com`,
        SES_INBOUND_TOPIC_ARN: props.mail.inboundTopicArn,
        SES_EVENTS_TOPIC_ARN: props.mail.eventsTopicArn,
      },
      gateway: {
        GATEWAY_HOST: "0.0.0.0",
        GATEWAY_PORT: String(servicePorts.gateway),
        ARTIFACTS_BUCKET: props.artifacts.bucketName,
        BLOB_BUCKET: props.blobs.bucketName,
        SES_CONFIGURATION_SET: props.mail.configurationSetName,
        TOKEN_KMS_KEY_ID: props.tokensKey.keyArn,
        WEB_PUBLIC_URL: publicUrl,
      },
      web: {
        WEB_HOST: "0.0.0.0",
        WEB_PORT: String(servicePorts.web),
        WEB_PUBLIC_URL: publicUrl,
        GATEWAY_PUBLIC_URL: `wss://gateway.${domain}`,
        TELEGRAM_BOT_USERNAME: "RunWinstonBot",
        TOKEN_KMS_KEY_ID: props.tokensKey.keyArn,
      },
      agents: {
        WEB_PUBLIC_URL: publicUrl,
        TOKEN_KMS_KEY_ID: props.tokensKey.keyArn,
        BLOB_BUCKET: props.blobs.bucketName,
        INBOUND_MAIL_BUCKET: props.mail.inboundBucket.bucketName,
        GATEWAY_INTERNAL_URL: `http://gateway.winston.internal:${String(servicePorts.gateway)}`,
        VM_GATEWAY_URL: `wss://gateway.${domain}`,
        VM_PROVIDER: "ec2",
        EC2_LAUNCH_TEMPLATE: props.vm.launchTemplateName,
        EC2_SUBNET_IDS: props.vm.subnetIds.join(","),
        GMAIL_PUSH_TOPIC: `projects/${gcpProject}/topics/gmail-push`,
        CALENDAR_PUSH_URL: `https://api.${domain}/webhooks/calendar`,
        // In-flight steps get most of the stop timeout to finish and checkpoint (§8b).
        SHUTDOWN_TIMEOUT_MS: String((agentsStopSeconds - 10) * 1000),
      },
    };

    const taskDefinitions = {} as Record<Service, FargateTaskDefinition>;
    const services = {} as Record<Service, FargateService>;
    for (const service of Object.keys(sizes) as Service[]) {
      const taskDefinition = new FargateTaskDefinition(this, `${service}Task`, {
        cpu: sizes[service].cpu,
        memoryLimitMiB: sizes[service].memoryMiB,
        runtimePlatform: {
          cpuArchitecture: CpuArchitecture.ARM64,
          operatingSystemFamily: OperatingSystemFamily.LINUX,
        },
      });
      const port = service === "agents" ? undefined : servicePorts[service];
      taskDefinition.addContainer(service, {
        image: ContainerImage.fromEcrRepository(
          props.repositories[service],
          imageTag,
        ),
        environment: {
          ...environment[service],
          LOG_LEVEL: "info",
          DATABASE_URL: databaseUrl,
          DATABASE_SECRET_ARN: props.database.secretArn,
        },
        secrets: this.secrets.environmentFor(service),
        portMappings: port ? [{ containerPort: port }] : [],
        logging: LogDrivers.awsLogs({
          streamPrefix: service,
          logGroup: new LogGroup(this, `${service}Logs`, {
            retention: RetentionDays.ONE_MONTH,
          }),
        }),
        // agents has no port; ECS replaces it if the process exits. Its
        // steps (model calls, commands) get Fargate's longest stop timeout.
        stopTimeout: Duration.seconds(
          service === "agents" ? agentsStopSeconds : 30,
        ),
      });
      // Each new connection reads the current password (§12a).
      databaseSecret.grantRead(taskDefinition.taskRole);
      taskDefinitions[service] = taskDefinition;

      services[service] = new FargateService(this, `${service}Service`, {
        cluster: this.cluster,
        taskDefinition,
        desiredCount: props.desiredCounts[service],
        // Public subnets with public IPs instead of a NAT gateway (§8).
        vpcSubnets: { subnetType: SubnetType.PUBLIC },
        assignPublicIp: true,
        securityGroups: [props.securityGroups[service]],
        minHealthyPercent: 100,
        maxHealthyPercent: 200,
        circuitBreaker: { enable: true, rollback: true },
        ...(service === "gateway"
          ? { cloudMapOptions: { name: "gateway" } }
          : {}),
      });
    }
    this.taskDefinitions = taskDefinitions;
    this.services = services;

    // Ops: `bun run prod <command>` runs this as a one-off task, and deploys
    // run migrations with it (docs/runbooks/production.md).
    this.opsTaskDefinition = new FargateTaskDefinition(this, "opsTask", {
      // Named, so GitHub's deploy role can run it (infra/src/ci.ts).
      family: "winston-ops",
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform: {
        cpuArchitecture: CpuArchitecture.ARM64,
        operatingSystemFamily: OperatingSystemFamily.LINUX,
      },
    });
    this.opsTaskDefinition.addContainer("ops", {
      image: ContainerImage.fromEcrRepository(props.repositories.ops, imageTag),
      environment: {
        DATABASE_URL: databaseUrl,
        DATABASE_SECRET_ARN: props.database.secretArn,
      },
      logging: LogDrivers.awsLogs({
        streamPrefix: "ops",
        logGroup: new LogGroup(this, "opsLogs", {
          logGroupName: "/winston/ops",
          retention: RetentionDays.ONE_MONTH,
        }),
      }),
    });
    databaseSecret.grantRead(this.opsTaskDefinition.taskRole);

    // Tokens: api and agents read and write them, the gateway reads them for
    // mail and calendar calls, and web only seals new ones.
    for (const service of ["api", "agents"] as const)
      props.tokensKey.grant(
        taskDefinitions[service].taskRole,
        "kms:Decrypt",
        "kms:GenerateDataKey",
      );
    props.tokensKey.grant(taskDefinitions.gateway.taskRole, "kms:Decrypt");
    props.tokensKey.grant(taskDefinitions.web.taskRole, "kms:GenerateDataKey");
    // agents runs users' VMs (the EC2 VmProvider).
    taskDefinitions.agents.taskRole.addManagedPolicy(props.vm.backendPolicy);
    // The gateway reads the VM manifest and presigns binary downloads (§10).
    props.artifacts.grantRead(taskDefinitions.gateway.taskRole);
    // Winston's raw mail is a blob: the gateway reads it for attachments
    // and stores what he sends, which it sends through SES.
    props.blobs.grantRead(taskDefinitions.gateway.taskRole);
    props.blobs.grantPut(taskDefinitions.gateway.taskRole);
    taskDefinitions.gateway.taskRole.addToPrincipalPolicy(
      new PolicyStatement({
        actions: ["ses:SendEmail", "ses:SendRawEmail"],
        resources: [
          props.mail.identityArn,
          Stack.of(this).formatArn({
            service: "ses",
            resource: "configuration-set",
            resourceName: props.mail.configurationSetName,
          }),
        ],
      }),
    );
    // Only agents stores blobs (§12).
    props.blobs.grantRead(taskDefinitions.agents.taskRole);
    props.blobs.grantPut(taskDefinitions.agents.taskRole);
    props.blobs.grantDelete(taskDefinitions.agents.taskRole);
    // agents takes Winston's received mail from where SES left it, and
    // bounces what no mailbox takes.
    props.mail.inboundBucket.grantRead(taskDefinitions.agents.taskRole);
    props.mail.inboundBucket.grantDelete(taskDefinitions.agents.taskRole);
    taskDefinitions.agents.taskRole.addToPrincipalPolicy(
      new PolicyStatement({
        actions: ["ses:SendBounce"],
        resources: [props.mail.identityArn],
      }),
    );

    this.loadBalancer = new ApplicationLoadBalancer(this, "LoadBalancer", {
      vpc: props.vpc,
      internetFacing: true,
      vpcSubnets: { subnetType: SubnetType.PUBLIC },
      securityGroup: props.securityGroups.alb,
      // VMs ping the gateway every 20 s, well inside this.
      idleTimeout: Duration.seconds(60),
    });
    const listener = this.loadBalancer.addListener("Https", {
      port: 443,
      certificates: [props.certificate],
      sslPolicy: SslPolicy.RECOMMENDED_TLS,
      // The security groups say who may connect; the rules say what's routed.
      open: false,
      defaultAction: ListenerAction.fixedResponse(404, {
        contentType: "text/plain",
        messageBody: "not found",
      }),
    });

    const targets = (service: Exclude<Service, "agents">) =>
      new ApplicationTargetGroup(this, `${service}Targets`, {
        vpc: props.vpc,
        targetType: TargetType.IP,
        port: servicePorts[service],
        protocol: ApplicationProtocol.HTTP,
        targets: [services[service]],
        healthCheck: {
          path: "/health",
          interval: Duration.seconds(15),
          healthyThresholdCount: 2,
          unhealthyThresholdCount: 3,
        },
        deregistrationDelay: Duration.seconds(30),
      });

    listener.addAction("Api", {
      priority: 10,
      conditions: [ListenerCondition.hostHeaders([`api.${domain}`])],
      action: ListenerAction.forward([targets("api")]),
    });
    // The VM websocket and the browser page's live view, the sockets the
    // gateway upgrades (apps/gateway/src/gateway.ts); the internal API is
    // never routed.
    listener.addAction("Gateway", {
      priority: 20,
      conditions: [
        ListenerCondition.hostHeaders([`gateway.${domain}`]),
        ListenerCondition.pathPatterns(["/vm/connect", "/browser/connect"]),
      ],
      action: ListenerAction.forward([targets("gateway")]),
    });
    // The site, only through CloudFront: it adds a header whose value is a
    // generated secret, and the load balancer serves web only with it.
    const originSecret = new Secret(this, "OriginSecret", {
      secretName: "winston/cloudfront-origin-header",
      description: "CloudFront's header to the load balancer; generated",
      generateSecretString: { excludePunctuation: true, passwordLength: 48 },
      removalPolicy: RemovalPolicy.RETAIN,
    });
    // A CloudFormation dynamic reference, resolved at deploy time.
    const originSecretValue = originSecret.secretValue.unsafeUnwrap();
    listener.addAction("Web", {
      priority: 30,
      conditions: [
        ListenerCondition.hostHeaders([domain]),
        ListenerCondition.httpHeader(originHeader, [originSecretValue]),
      ],
      action: ListenerAction.forward([targets("web")]),
    });

    // CloudFront forwards the viewer's Host, so the load balancer routes it
    // to web and TLS to the origin is checked against runwinston.com.
    const origin = new LoadBalancerV2Origin(this.loadBalancer, {
      protocolPolicy: OriginProtocolPolicy.HTTPS_ONLY,
      customHeaders: { [originHeader]: originSecretValue },
    });
    this.distribution = new Distribution(this, "Site", {
      comment: `${domain}: the web service`,
      domainNames: [domain],
      certificate: props.certificate,
      minimumProtocolVersion: SecurityPolicyProtocol.TLS_V1_2_2021,
      httpVersion: HttpVersion.HTTP2_AND_3,
      // North America and Europe; the users are in the US.
      priceClass: PriceClass.PRICE_CLASS_100,
      // Pages and server functions: never cached, with cookies and all.
      defaultBehavior: {
        origin,
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: AllowedMethods.ALLOW_ALL,
        cachePolicy: CachePolicy.CACHING_DISABLED,
        originRequestPolicy: OriginRequestPolicy.ALL_VIEWER,
      },
      additionalBehaviors: {
        // Hashed build assets: cached for as long as the origin says (a year).
        "/assets/*": {
          origin,
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: CachePolicy.CACHING_OPTIMIZED,
          originRequestPolicy: OriginRequestPolicy.HOST_HEADER_ONLY,
        },
      },
    });

    // What `bun run prod` needs to start an ops task.
    new CfnOutput(this, "ClusterName", { value: this.cluster.clusterName });
    new CfnOutput(this, "OpsTaskDefinition", {
      value: this.opsTaskDefinition.family,
    });
    new CfnOutput(this, "OpsSubnets", {
      value: props.vpc
        .selectSubnets({ subnetType: SubnetType.PUBLIC })
        .subnetIds.join(","),
    });
    new CfnOutput(this, "OpsSecurityGroup", {
      value: props.securityGroups.ops.securityGroupId,
    });
    new CfnOutput(this, "DistributionDomainName", {
      description: "The target of the apex CNAME (docs/runbooks/dns.md)",
      value: this.distribution.distributionDomainName,
    });
    new CfnOutput(this, "LoadBalancerDnsName", {
      description: `The target of the api and gateway CNAMEs (docs/runbooks/dns.md)`,
      value: this.loadBalancer.loadBalancerDnsName,
    });
  }
}
