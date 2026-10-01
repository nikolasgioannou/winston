/**
 * `bun run vm:publish`: publishes the VM binaries for self-update
 * (docs/design.md §10). Compiles the winston CLI and winstond for linux-x64,
 * signs each one's SHA-256 with the KMS key alias/winston/vm-binary-signing
 * (the private key never leaves KMS), checks the signature against the
 * public key winstond carries, uploads both to the artifacts bucket under
 * `vm/<version>/`, and writes `vm/latest.json` last, so the gateway never
 * reads a manifest naming binaries that aren't there. The gateway offers the
 * new version to every connected VM within a minute.
 *
 * Deploys run it (GitHub's deploy role may sign); it uses the winston-prod
 * profile unless AWS credentials are already set.
 */
import { $ } from "bun";
import { createHash, verify } from "node:crypto";
import { signingPublicKey } from "../apps/winstond/src/signing-key.ts";
import { buildVersion, compileVmBinaries } from "./vm-binaries.ts";

const env = {
  ...process.env,
  AWS_REGION: "us-east-1",
  ...(process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE
    ? {}
    : { AWS_PROFILE: "winston-prod" }),
};

const version = buildVersion();
if (version.endsWith(".dirty") && !Bun.argv.includes("--dirty")) {
  console.error(
    `Refusing to publish ${version}: commit first (or pass --dirty to test).`,
  );
  process.exit(1);
}

const bucket = (
  await $`aws cloudformation describe-stack-resources --stack-name winston-data --query ${"StackResources[?ResourceType=='AWS::S3::Bucket' && starts_with(LogicalResourceId,'Artifacts')].PhysicalResourceId"} --output text`
    .env(env)
    .text()
).trim();
if (!bucket) throw new Error("No artifacts bucket in the Data stack.");

console.log(`Publishing VM binaries ${version} to s3://${bucket}/vm/`);
await compileVmBinaries("x64", version);

const binaries: Record<
  string,
  { key: string; sha256: string; signature: string }
> = {};
for (const name of ["winston", "winstond"] as const) {
  const path = `image/build/${name}-linux-x64`;
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const digestPath = `${path}.sha256.bin`;
  await Bun.write(digestPath, Buffer.from(sha256, "hex"));
  const signature = (
    await $`aws kms sign --key-id alias/winston/vm-binary-signing --message ${`fileb://${digestPath}`} --message-type DIGEST --signing-algorithm ECDSA_SHA_256 --query Signature --output text`
      .env(env)
      .text()
  ).trim();
  // The same check winstond makes, so a bad signature never ships.
  if (
    !verify("sha256", bytes, signingPublicKey, Buffer.from(signature, "base64"))
  )
    throw new Error(`The signature for ${name} doesn't verify.`);
  const key = `vm/${version}/${name}-linux-x64`;
  await $`aws s3 cp ${path} ${`s3://${bucket}/${key}`} --only-show-errors`.env(
    env,
  );
  binaries[name] = { key, sha256, signature };
  console.log(`  ${name}: ${sha256.slice(0, 12)}… signed and uploaded`);
}

const manifestPath = "image/build/latest.json";
await Bun.write(manifestPath, JSON.stringify({ version, binaries }, null, 2));
await $`aws s3 cp ${manifestPath} ${`s3://${bucket}/vm/latest.json`} --content-type application/json --cache-control no-cache --only-show-errors`.env(
  env,
);
console.log(`Published: vm/latest.json now names ${version}.`);
