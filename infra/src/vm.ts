import { Stack, type StackProps } from "aws-cdk-lib";
import { CfnLifecyclePolicy } from "aws-cdk-lib/aws-dlm";
import {
  BlockDeviceVolume,
  CfnLaunchTemplate,
  EbsDeviceVolumeType,
  InstanceClass,
  InstanceSize,
  InstanceType,
  LaunchTemplate,
  LaunchTemplateHttpTokens,
  MachineImage,
  type ISecurityGroup,
} from "aws-cdk-lib/aws-ec2";
import {
  Effect,
  ManagedPolicy,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";

/** The SSM parameter naming the AMI new VMs launch from (`image:build:ami`). */
export const amiParameter = "/winston/vm-ami";

/**
 * Tags on what the backend creates, and what the policies below match:
 * `winston:role` is `vm` on instances, `data` on data volumes (and so on
 * their snapshots, which copy the volume's tags), `root` on root volumes.
 */
export const roleTag = "winston:role";

export interface VmStackProps extends StackProps {
  vmSecurityGroup: ISecurityGroup;
}

/**
 * Everything around users' VMs (docs/design.md §10, §19); the VMs themselves
 * are created at runtime by `agents` (the EC2 VmProvider).
 */
export class VmStack extends Stack {
  readonly launchTemplate: LaunchTemplate;
  /** Attached to agents' task role: just enough EC2 to run users' VMs. */
  readonly backendPolicy: ManagedPolicy;

  constructor(scope: Construct, id: string, props: VmStackProps) {
    super(scope, id, props);

    // VMs hold no useful AWS permissions: Session Manager for admin access,
    // and nothing else. Self-updates download through presigned URLs (§10).
    const role = new Role(this, "InstanceRole", {
      assumedBy: new ServicePrincipal("ec2.amazonaws.com"),
      description: "Winston VMs: SSM Session Manager only",
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore"),
      ],
    });

    this.launchTemplate = new LaunchTemplate(this, "LaunchTemplate", {
      launchTemplateName: "winston-vm",
      instanceType: InstanceType.of(InstanceClass.T3A, InstanceSize.MEDIUM),
      // Resolved by EC2 at each launch, so a new AMI needs no deploy.
      machineImage: MachineImage.resolveSsmParameterAtLaunch(amiParameter),
      role,
      securityGroup: props.vmSecurityGroup,
      requireImdsv2: true,
      httpTokens: LaunchTemplateHttpTokens.REQUIRED,
      httpPutResponseHopLimit: 1,
      blockDevices: [
        {
          deviceName: "/dev/sda1",
          volume: BlockDeviceVolume.ebs(12, {
            volumeType: EbsDeviceVolumeType.GP3,
            encrypted: true,
            deleteOnTermination: true,
          }),
        },
      ],
    });
    // Tags on what each launch creates, so the backend's permissions and the
    // snapshot policy can tell the pieces apart.
    const cfn = this.launchTemplate.node.defaultChild as CfnLaunchTemplate;
    cfn.addPropertyOverride("LaunchTemplateData.TagSpecifications", [
      {
        ResourceType: "instance",
        Tags: [
          { Key: "Name", Value: "winston-vm" },
          { Key: roleTag, Value: "vm" },
        ],
      },
      { ResourceType: "volume", Tags: [{ Key: roleTag, Value: "root" }] },
    ]);

    // Nightly snapshots of every data volume, kept 14 days (§10): 07:00 UTC
    // is the early hours in New York. Snapshots copy the volume's tags.
    const dlmRole = new Role(this, "SnapshotRole", {
      assumedBy: new ServicePrincipal("dlm.amazonaws.com"),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AWSDataLifecycleManagerServiceRole",
        ),
      ],
    });
    new CfnLifecyclePolicy(this, "Snapshots", {
      description: "Nightly snapshots of Winston data volumes kept 14 days",
      state: "ENABLED",
      executionRoleArn: dlmRole.roleArn,
      policyDetails: {
        policyType: "EBS_SNAPSHOT_MANAGEMENT",
        resourceTypes: ["VOLUME"],
        targetTags: [{ key: roleTag, value: "data" }],
        schedules: [
          {
            name: "nightly",
            copyTags: true,
            createRule: {
              interval: 24,
              intervalUnit: "HOURS",
              times: ["07:00"],
            },
            retainRule: { count: 14 },
          },
        ],
      },
    });

    // agents runs the EC2 VmProvider. It may launch only from this template,
    // create and delete only tagged data volumes and their snapshots, and
    // start, stop, attach to or terminate only tagged VMs.
    const region = this.region;
    const account = this.account;
    const arn = (resource: string) =>
      `arn:aws:ec2:${region}:${account}:${resource}`;
    const templateId = this.launchTemplate.launchTemplateId;
    if (!templateId) throw new Error("The launch template has no id.");
    const templateArn = arn(`launch-template/${templateId}`);
    const tagged = (value: string) => ({
      StringEquals: { [`aws:ResourceTag/${roleTag}`]: value },
    });
    this.backendPolicy = new ManagedPolicy(this, "BackendPolicy", {
      description: "agents: run users' VMs from the winston-vm launch template",
      statements: [
        new PolicyStatement({
          sid: "LaunchFromTheTemplateOnly",
          actions: ["ec2:RunInstances"],
          resources: [
            arn("instance/*"),
            arn("volume/*"),
            arn("network-interface/*"),
          ],
          conditions: { ArnEquals: { "ec2:LaunchTemplate": templateArn } },
        }),
        new PolicyStatement({
          sid: "LaunchResources",
          actions: ["ec2:RunInstances"],
          resources: [
            templateArn,
            arn("subnet/*"),
            arn("security-group/*"),
            `arn:aws:ec2:${region}::image/*`,
          ],
        }),
        new PolicyStatement({
          sid: "ResolveTheAmi",
          actions: ["ssm:GetParameters", "ssm:GetParameter"],
          resources: [
            `arn:aws:ssm:${region}:${account}:parameter${amiParameter}`,
          ],
        }),
        new PolicyStatement({
          sid: "PassTheInstanceRole",
          actions: ["iam:PassRole"],
          resources: [role.roleArn],
        }),
        new PolicyStatement({
          sid: "CreateTaggedDataVolumes",
          actions: ["ec2:CreateVolume"],
          resources: [arn("volume/*")],
          conditions: {
            StringEquals: { [`aws:RequestTag/${roleTag}`]: "data" },
          },
        }),
        new PolicyStatement({
          // Restoring a VM creates its volume from a data snapshot, which is
          // authorized against the snapshot too.
          sid: "RestoreFromDataSnapshots",
          actions: ["ec2:CreateVolume"],
          resources: [`arn:aws:ec2:${region}::snapshot/*`],
          conditions: tagged("data"),
        }),
        new PolicyStatement({
          sid: "TagWhatItCreates",
          actions: ["ec2:CreateTags"],
          resources: [
            arn("instance/*"),
            arn("volume/*"),
            arn("network-interface/*"),
          ],
          conditions: {
            StringEquals: {
              "ec2:CreateAction": ["RunInstances", "CreateVolume"],
            },
          },
        }),
        new PolicyStatement({
          sid: "ManageTaggedVms",
          actions: [
            "ec2:StartInstances",
            "ec2:StopInstances",
            "ec2:TerminateInstances",
            "ec2:AttachVolume",
            "ec2:DetachVolume",
          ],
          resources: [arn("instance/*")],
          conditions: tagged("vm"),
        }),
        new PolicyStatement({
          sid: "ManageTaggedDataVolumes",
          actions: ["ec2:AttachVolume", "ec2:DetachVolume", "ec2:DeleteVolume"],
          resources: [arn("volume/*")],
          conditions: tagged("data"),
        }),
        new PolicyStatement({
          sid: "DeleteTaggedSnapshots",
          actions: ["ec2:DeleteSnapshot"],
          resources: [`arn:aws:ec2:${region}::snapshot/*`],
          conditions: tagged("data"),
        }),
        new PolicyStatement({
          sid: "Describe",
          effect: Effect.ALLOW,
          // Describe calls have no resource-level permissions.
          actions: [
            "ec2:DescribeInstances",
            "ec2:DescribeVolumes",
            "ec2:DescribeSnapshots",
            "ec2:DescribeSubnets",
          ],
          resources: ["*"],
        }),
      ],
    });
  }
}
