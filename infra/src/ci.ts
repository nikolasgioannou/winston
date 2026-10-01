import { RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { Repository, TagMutability } from "aws-cdk-lib/aws-ecr";
import {
  OidcProviderNative,
  OpenIdConnectPrincipal,
  PolicyStatement,
  Role,
} from "aws-cdk-lib/aws-iam";
import type { IKey } from "aws-cdk-lib/aws-kms";
import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
  type IBucket,
} from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";
import type { Service } from "./secrets.ts";

/**
 * The only repository and branch whose workflows may assume the roles below.
 * The repository uses GitHub's immutable subject format: owner and repository
 * carry their numeric ids, so a renamed or re-created repository with the
 * same name can't match (`gh api repos/nikolasgioannou/winston/actions/oidc/customization/sub`).
 */
export const githubSubject =
  "repo:nikolasgioannou@48188665/winston@1390141974:ref:refs/heads/main";

export interface CiStackProps extends StackProps {
  artifacts: IBucket;
  signingKey: IKey;
}

/** Everything that ships as an image, one repository each: the services and ops. */
export const images = ["api", "agents", "gateway", "web", "ops"] as const;

export type Image = Service | "ops";

/**
 * What deploys build on (docs/design.md §8b, §19): the image repositories,
 * which exist before the Services stack so images can be pushed before the
 * first service starts, and the roles GitHub Actions assumes through OIDC, so
 * no AWS keys are stored in GitHub.
 */
export class CiStack extends Stack {
  readonly repositories: Record<Image, Repository>;
  readonly deployRole: Role;
  readonly amiRole: Role;
  readonly terraformState: Bucket;

  constructor(scope: Construct, id: string, props: CiStackProps) {
    super(scope, id, props);
    this.repositories = Object.fromEntries(
      images.map((image) => [
        image,
        new Repository(this, `${image}Repository`, {
          repositoryName: `winston/${image}`,
          // Tags are commit SHAs; a pushed tag never changes meaning.
          imageTagMutability: TagMutability.IMMUTABLE,
          imageScanOnPush: true,
          lifecycleRules: [
            {
              description: "Keep the last 30 images, enough to roll back",
              maxImageCount: 30,
            },
          ],
          removalPolicy: RemovalPolicy.RETAIN,
        }),
      ]),
    ) as Record<Image, Repository>;

    const github = new OidcProviderNative(this, "GitHub", {
      url: "https://token.actions.githubusercontent.com",
      clientIds: ["sts.amazonaws.com"],
    });
    // Only workflows on main in this repository.
    const trust = () =>
      new OpenIdConnectPrincipal(github, {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": githubSubject,
        },
      });
    const { account, region } = this;

    // Deploys (.github/workflows/ci.yml). CloudFormation changes go through
    // CDK's bootstrap roles, which this role assumes; it holds only what the
    // workflow does itself.
    this.deployRole = new Role(this, "DeployRole", {
      roleName: "winston-github-deploy",
      assumedBy: trust(),
      description: "GitHub Actions deploys from main (OIDC)",
    });
    const deploy = (statement: PolicyStatement) => {
      this.deployRole.addToPolicy(statement);
    };
    deploy(
      new PolicyStatement({
        sid: "AssumeCdkBootstrapRoles",
        actions: ["sts:AssumeRole"],
        resources: [
          `arn:aws:iam::${account}:role/cdk-hnb659fds-*-role-${account}-${region}`,
        ],
      }),
    );
    deploy(
      new PolicyStatement({
        sid: "EcrLogin",
        actions: ["ecr:GetAuthorizationToken"],
        resources: ["*"],
      }),
    );
    for (const repository of Object.values(this.repositories)) {
      repository.grantPullPush(this.deployRole);
      // Whether a commit's image is already pushed (tags are immutable).
      repository.grant(this.deployRole, "ecr:DescribeImages");
    }
    deploy(
      new PolicyStatement({
        sid: "SetTheImageTag",
        actions: ["ssm:PutParameter", "ssm:GetParameter"],
        resources: [
          `arn:aws:ssm:${region}:${account}:parameter/winston/image-tag`,
        ],
      }),
    );
    deploy(
      new PolicyStatement({
        sid: "ReadStacks",
        actions: [
          "cloudformation:DescribeStacks",
          "cloudformation:DescribeStackResources",
        ],
        resources: [
          `arn:aws:cloudformation:${region}:${account}:stack/winston-*/*`,
        ],
      }),
    );
    // Migrations and admin commands: the ops task (infra/src/services.ts).
    deploy(
      new PolicyStatement({
        sid: "RunOpsTasks",
        actions: ["ecs:RunTask"],
        resources: [
          `arn:aws:ecs:${region}:${account}:task-definition/winston-ops:*`,
        ],
      }),
    );
    // Migrations run on the new image before the services move to it, so
    // the ops task is re-registered with that tag (scripts/prod.ts --image).
    deploy(
      new PolicyStatement({
        sid: "RegisterOpsRevisions",
        // RegisterTaskDefinition has no resource-level permissions.
        actions: ["ecs:RegisterTaskDefinition"],
        resources: ["*"],
      }),
    );
    deploy(
      new PolicyStatement({
        sid: "WatchTasks",
        actions: [
          "ecs:DescribeTasks",
          "ecs:DescribeTaskDefinition",
          "ecs:DescribeServices",
        ],
        resources: ["*"],
      }),
    );
    deploy(
      new PolicyStatement({
        sid: "PassOpsTaskRoles",
        actions: ["iam:PassRole"],
        resources: [`arn:aws:iam::${account}:role/winston-services-*`],
        conditions: {
          StringEquals: { "iam:PassedToService": "ecs-tasks.amazonaws.com" },
        },
      }),
    );
    deploy(
      new PolicyStatement({
        sid: "ReadOpsLogs",
        actions: ["logs:GetLogEvents"],
        resources: [
          `arn:aws:logs:${region}:${account}:log-group:/winston/ops:*`,
        ],
      }),
    );
    // Publishing VM binaries (scripts/publish-vm-binaries.ts).
    props.artifacts.grantPut(this.deployRole, "vm/*");
    props.signingKey.grant(this.deployRole, "kms:Sign");

    // Building the AMI by hand (.github/workflows/ami.yml): what Packer's
    // amazon-ebs builder needs, and recording the AMI.
    this.amiRole = new Role(this, "AmiRole", {
      roleName: "winston-github-ami",
      assumedBy: trust(),
      description: "GitHub Actions AMI builds from main (OIDC)",
    });
    this.amiRole.addToPolicy(
      new PolicyStatement({
        sid: "Packer",
        // Packer's documented minimum for amazon-ebs, plus copying for encryption.
        actions: [
          "ec2:AttachVolume",
          "ec2:AuthorizeSecurityGroupIngress",
          "ec2:CopyImage",
          "ec2:CreateImage",
          "ec2:CreateKeyPair",
          "ec2:CreateSecurityGroup",
          "ec2:CreateSnapshot",
          "ec2:CreateTags",
          "ec2:CreateVolume",
          "ec2:DeleteKeyPair",
          "ec2:DeleteSecurityGroup",
          "ec2:DeleteSnapshot",
          "ec2:DeleteVolume",
          "ec2:DeregisterImage",
          "ec2:DescribeImageAttribute",
          "ec2:DescribeImages",
          "ec2:DescribeInstances",
          "ec2:DescribeInstanceStatus",
          "ec2:DescribeRegions",
          "ec2:DescribeSecurityGroups",
          "ec2:DescribeSnapshots",
          "ec2:DescribeSubnets",
          "ec2:DescribeTags",
          "ec2:DescribeVolumes",
          "ec2:DescribeVpcs",
          "ec2:DetachVolume",
          "ec2:GetPasswordData",
          "ec2:ModifyImageAttribute",
          "ec2:ModifyInstanceAttribute",
          "ec2:ModifySnapshotAttribute",
          "ec2:RegisterImage",
          "ec2:RunInstances",
          "ec2:StopInstances",
          "ec2:TerminateInstances",
        ],
        resources: ["*"],
      }),
    );
    this.amiRole.addToPolicy(
      new PolicyStatement({
        sid: "RecordTheAmi",
        actions: ["ssm:PutParameter"],
        resources: [
          `arn:aws:ssm:${region}:${account}:parameter/winston/vm-ami`,
        ],
      }),
    );

    // Terraform's state for the small GCP footprint (infra/gcp), with S3's
    // native locking; applied by hand (docs/runbooks/gcp-terraform.md).
    this.terraformState = new Bucket(this, "TerraformState", {
      bucketName: `winston-terraform-state-${this.account}`,
      versioned: true,
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
  }
}
