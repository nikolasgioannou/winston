import { Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import {
  InstanceClass,
  InstanceSize,
  InstanceType,
  SubnetType,
  type ISecurityGroup,
  type IVpc,
} from "aws-cdk-lib/aws-ec2";
import { Key, KeySpec, KeyUsage } from "aws-cdk-lib/aws-kms";
import {
  CfnDBInstance,
  DatabaseInstance,
  DatabaseInstanceEngine,
  PostgresEngineVersion,
  StorageType,
} from "aws-cdk-lib/aws-rds";
import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
  ObjectOwnership,
} from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";

export interface DataStackProps extends StackProps {
  vpc: IVpc;
  databaseSecurityGroup: ISecurityGroup;
}

/**
 * Everything stateful (docs/design.md §12, §12a, §19): Postgres, the KMS keys
 * and the S3 buckets. Nothing here is ever deleted by CloudFormation: the stack
 * has termination protection and every resource is retained.
 */
export class DataStack extends Stack {
  readonly database: DatabaseInstance;
  /** The RDS-managed secret holding the master password. */
  readonly databaseSecretArn: string;
  /** Envelope encryption for connection tokens (the token vault). */
  readonly tokensKey: Key;
  /** Signs VM binaries; VMs verify with its public key. */
  readonly signingKey: Key;
  /** VM binaries and their signatures, read by VMs. */
  readonly artifacts: Bucket;
  /** Screenshots and attachments referenced from the model-call log. */
  readonly blobs: Bucket;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    this.database = new DatabaseInstance(this, "Database", {
      // The same major version as local (docs/design.md §8a).
      engine: DatabaseInstanceEngine.postgres({
        version: PostgresEngineVersion.of("18.6", "18"),
      }),
      instanceType: InstanceType.of(InstanceClass.T4G, InstanceSize.MICRO),
      vpc: props.vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
      securityGroups: [props.databaseSecurityGroup],
      publiclyAccessible: false,
      multiAz: false,
      databaseName: "winston",
      // RDS keeps the master password in Secrets Manager and rotates it every
      // 7 days; services read it for each new connection (§12a).
      manageMasterUserPassword: true,
      storageType: StorageType.GP3,
      allocatedStorage: 20,
      maxAllocatedStorage: 100,
      storageEncrypted: true,
      backupRetention: Duration.days(7),
      // Quiet hours in New York (UTC times).
      preferredBackupWindow: "07:00-07:30",
      preferredMaintenanceWindow: "sun:07:30-sun:08:30",
      autoMinorVersionUpgrade: true,
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.databaseSecretArn = (
      this.database.node.defaultChild as CfnDBInstance
    ).attrMasterUserSecretSecretArn;

    this.tokensKey = new Key(this, "TokensKey", {
      alias: "winston/tokens",
      description: "Connection tokens (envelope encryption)",
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // P-256 with ECDSA_SHA_256: verified offline with WebCrypto, no AWS call.
    this.signingKey = new Key(this, "SigningKey", {
      alias: "winston/vm-binary-signing",
      description: "Signs VM binaries",
      keySpec: KeySpec.ECC_NIST_P256,
      keyUsage: KeyUsage.SIGN_VERIFY,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const bucket = (name: string, versioned: boolean) =>
      new Bucket(this, name, {
        blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
        objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
        encryption: BucketEncryption.S3_MANAGED,
        enforceSSL: true,
        versioned,
        removalPolicy: RemovalPolicy.RETAIN,
        lifecycleRules: [
          { abortIncompleteMultipartUploadAfter: Duration.days(1) },
          ...(versioned
            ? [{ noncurrentVersionExpiration: Duration.days(90) }]
            : []),
        ],
      });

    // Versioned, so an overwritten binary can be recovered for 90 days.
    this.artifacts = bucket("Artifacts", true);
    // Keyed by content hash, so objects never change; they're the record and
    // never expire.
    this.blobs = bucket("Blobs", false);
  }
}
