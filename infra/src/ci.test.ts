import { describe, expect, test } from "bun:test";
import { Template } from "aws-cdk-lib/assertions";
import { testApp } from "./testing.ts";

interface Statement {
  Action: string | string[];
  Resource: unknown;
  Condition?: unknown;
}

describe("ci stack", () => {
  const { stacks } = testApp();
  const ci = stacks.ci;
  const template = Template.fromStack(ci);

  const roleProps = (name: string) =>
    Object.values(template.findResources("AWS::IAM::Role")).find(
      (role) => (role.Properties as { RoleName?: string }).RoleName === name,
    )?.Properties as {
      AssumeRolePolicyDocument: { Statement: Statement[] };
    };

  const statementsFor = (role: "deployRole" | "amiRole") => {
    const roleRef = JSON.stringify(ci.resolve(ci[role].roleName));
    return Object.values(template.findResources("AWS::IAM::Policy"))
      .map(
        (policy) =>
          policy.Properties as {
            Roles: unknown[];
            PolicyDocument: { Statement: Statement[] };
          },
      )
      .filter((policy) =>
        policy.Roles.some((r) => JSON.stringify(r) === roleRef),
      )
      .flatMap((policy) => policy.PolicyDocument.Statement);
  };

  test("Terraform's state bucket is private, versioned and kept", () => {
    template.hasResource("AWS::S3::Bucket", {
      Properties: {
        VersioningConfiguration: { Status: "Enabled" },
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      },
      DeletionPolicy: "Retain",
    });
  });

  test("GitHub's roles trust only main in this repository", () => {
    for (const name of ["winston-github-deploy", "winston-github-ami"]) {
      const [statement] = roleProps(name).AssumeRolePolicyDocument.Statement;
      expect(statement?.Action).toBe("sts:AssumeRoleWithWebIdentity");
      expect(statement?.Condition).toEqual({
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub":
            "repo:nikolasgioannou@48188665/winston@1390141974:ref:refs/heads/main",
        },
      });
    }
  });

  test("the deploy role has no wildcard actions, and its * resources are only for describes, login and registering ops revisions", () => {
    const statements = statementsFor("deployRole");
    expect(statements.length).toBeGreaterThan(5);
    for (const statement of statements) {
      const actions = [statement.Action].flat();
      expect(
        actions.some((action) => action === "*" || action.endsWith(":*")),
      ).toBe(false);
      if (statement.Resource === "*")
        expect(
          actions.every(
            (action) =>
              action === "ecr:GetAuthorizationToken" ||
              action === "ecs:RegisterTaskDefinition" ||
              action.startsWith("ecs:Describe") ||
              action === "ec2:DescribeImages",
          ),
        ).toBe(true);
    }
  });

  test("the deploy role changes infrastructure only through CDK's bootstrap roles", () => {
    const actions = statementsFor("deployRole").flatMap((s) =>
      [s.Action].flat(),
    );
    expect(
      actions.some((action) => action.startsWith("cloudformation:Create")),
    ).toBe(false);
    expect(
      actions.some((action) => action.startsWith("cloudformation:Update")),
    ).toBe(false);
    expect(actions).toContain("sts:AssumeRole");
    expect(actions).toContain("kms:Sign");
  });

  test("the AMI role can build images but can't pass roles, touch other services or move production onto an image", () => {
    const actions = statementsFor("amiRole").flatMap((s) => [s.Action].flat());
    expect(
      actions.every(
        (action) => action.startsWith("ec2:") || action === "ssm:GetParameter",
      ),
    ).toBe(true);
  });

  test("only the deploy role moves production onto a VM image", () => {
    const vmAmi = (role: "deployRole" | "amiRole") =>
      statementsFor(role).filter((s) =>
        [s.Resource].flat().some((r) => JSON.stringify(r).includes("vm-ami")),
      );
    expect(vmAmi("deployRole").flatMap((s) => [s.Action].flat())).toContain(
      "ssm:PutParameter",
    );
    expect(vmAmi("amiRole").flatMap((s) => [s.Action].flat())).toEqual([
      "ssm:GetParameter",
    ]);
  });
});
