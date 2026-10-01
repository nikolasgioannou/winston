import { describe, expect, test } from "bun:test";
import { Match, Template } from "aws-cdk-lib/assertions";
import { testApp } from "./testing.ts";

describe("data stack", () => {
  const { stacks } = testApp();
  const template = Template.fromStack(stacks.data);

  test("has termination protection", () => {
    expect(stacks.data.terminationProtection).toBe(true);
  });

  test("retains every database, key and bucket if removed from the stack", () => {
    for (const type of [
      "AWS::RDS::DBInstance",
      "AWS::KMS::Key",
      "AWS::S3::Bucket",
    ]) {
      const resources = Object.values(template.findResources(type));
      expect(resources.length).toBeGreaterThan(0);
      for (const resource of resources) {
        expect(resource.DeletionPolicy).toBe("Retain");
        expect(resource.UpdateReplacePolicy).toBe("Retain");
      }
    }
  });

  test("Postgres is private, encrypted, backed up and deletion-protected", () => {
    template.hasResourceProperties("AWS::RDS::DBInstance", {
      Engine: "postgres",
      EngineVersion: "18.6",
      DBInstanceClass: "db.t4g.micro",
      PubliclyAccessible: false,
      StorageEncrypted: true,
      DeletionProtection: true,
      BackupRetentionPeriod: 7,
      ManageMasterUserPassword: true,
    });
  });

  test("buckets block public access, are encrypted and require TLS", () => {
    const buckets = template.findResources("AWS::S3::Bucket");
    expect(Object.keys(buckets)).toHaveLength(2);
    for (const bucket of Object.values(buckets)) {
      const properties = bucket.Properties as Record<string, unknown>;
      expect(properties.PublicAccessBlockConfiguration).toEqual({
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      });
      expect(properties.BucketEncryption).toBeDefined();
    }
    template.resourcePropertiesCountIs(
      "AWS::S3::BucketPolicy",
      {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: "Deny",
              Condition: { Bool: { "aws:SecureTransport": "false" } },
            }),
          ]),
        },
      },
      2,
    );
  });

  test("the signing key is asymmetric and the tokens key rotates", () => {
    template.hasResourceProperties("AWS::KMS::Key", {
      KeySpec: "ECC_NIST_P256",
      KeyUsage: "SIGN_VERIFY",
    });
    template.hasResourceProperties("AWS::KMS::Key", {
      EnableKeyRotation: true,
      KeySpec: Match.absent(),
    });
  });

  test("key policies grant nothing beyond the account itself", () => {
    const keys = template.findResources("AWS::KMS::Key");
    for (const key of Object.values(keys)) {
      const statements = (
        key.Properties as {
          KeyPolicy: { Statement: { Effect: string; Principal: unknown }[] };
        }
      ).KeyPolicy.Statement;
      for (const statement of statements) {
        // Access comes from IAM policies on each role, which the account
        // principal delegates to; never from "*" or another account.
        expect(statement.Principal).toEqual({
          AWS: "arn:aws:iam::766577085959:root",
        });
      }
    }
  });
});
