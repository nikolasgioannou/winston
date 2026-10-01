import { describe, expect, test } from "bun:test";
import { Match, Template } from "aws-cdk-lib/assertions";
import { testApp } from "./testing.ts";

interface Statement {
  Sid?: string;
  Action: string | string[];
  Resource: unknown;
  Condition?: Record<string, Record<string, unknown>>;
}

describe("vm stack", () => {
  const { stacks } = testApp();
  const template = Template.fromStack(stacks.vm);

  const statementsOf = (
    type: string,
    match: (props: Record<string, unknown>) => boolean,
  ) =>
    Object.values(template.findResources(type))
      .map((resource) => resource.Properties as Record<string, unknown>)
      .filter(match)
      .flatMap(
        (props) =>
          (props.PolicyDocument as { Statement: Statement[] }).Statement,
      );

  test("the launch template requires IMDSv2 and resolves the AMI at launch", () => {
    template.hasResourceProperties("AWS::EC2::LaunchTemplate", {
      LaunchTemplateName: "winston-vm",
      LaunchTemplateData: Match.objectLike({
        InstanceType: "t3a.medium",
        ImageId: "resolve:ssm:/winston/vm-ami",
        MetadataOptions: Match.objectLike({
          HttpTokens: "required",
          HttpPutResponseHopLimit: 1,
        }),
      }),
    });
  });

  test("VMs may use Session Manager and read artifacts, and nothing else", () => {
    template.hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: [
          Match.objectLike({ Principal: { Service: "ec2.amazonaws.com" } }),
        ],
      }),
      ManagedPolicyArns: [
        Match.objectLike({
          "Fn::Join": Match.arrayWith([
            Match.arrayWith([":iam::aws:policy/AmazonSSMManagedInstanceCore"]),
          ]),
        }),
      ],
    });
    const instanceRolePolicies = statementsOf("AWS::IAM::Policy", (props) =>
      JSON.stringify(props.Roles).includes("InstanceRole"),
    );
    const actions = instanceRolePolicies.flatMap((s) => [s.Action].flat());
    expect(
      actions.every(
        (action) => action.startsWith("s3:Get") || action.startsWith("s3:List"),
      ),
    ).toBe(true);
  });

  test("agents can launch only from the template and touch only tagged resources", () => {
    const statements = statementsOf("AWS::IAM::ManagedPolicy", () => true);
    const bySid: Record<string, Statement | undefined> = Object.fromEntries(
      statements.map((statement) => [statement.Sid ?? "", statement]),
    );
    expect(
      bySid.LaunchFromTheTemplateOnly?.Condition?.ArnEquals,
    ).toHaveProperty("ec2:LaunchTemplate");
    expect(bySid.CreateTaggedDataVolumes?.Condition).toEqual({
      StringEquals: { "aws:RequestTag/winston:role": "data" },
    });
    for (const sid of [
      "ManageTaggedVms",
      "ManageTaggedDataVolumes",
      "DeleteTaggedSnapshots",
    ])
      expect(Object.keys(bySid[sid]?.Condition?.StringEquals ?? {})).toEqual([
        "aws:ResourceTag/winston:role",
      ]);
    // Only describe calls run on every resource.
    for (const statement of statements)
      if (statement.Resource === "*")
        expect(
          [statement.Action]
            .flat()
            .every((action) => action.startsWith("ec2:Describe")),
        ).toBe(true);
  });

  test("data volumes are snapshotted nightly and kept 14 days", () => {
    template.hasResourceProperties("AWS::DLM::LifecyclePolicy", {
      State: "ENABLED",
      PolicyDetails: Match.objectLike({
        TargetTags: [{ Key: "winston:role", Value: "data" }],
        Schedules: [
          Match.objectLike({
            CopyTags: true,
            CreateRule: {
              Interval: 24,
              IntervalUnit: "HOURS",
              Times: ["07:00"],
            },
            RetainRule: { Count: 14 },
          }),
        ],
      }),
    });
  });
});
