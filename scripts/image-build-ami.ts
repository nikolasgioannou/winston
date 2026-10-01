/**
 * `bun run image:build:ami`: compiles the winston CLI and winstond for
 * linux-x64, builds the production AMI from image/winston.pkr.hcl (the same
 * provisioning as the local image, plus the EC2-only steps), records its id
 * in the SSM parameter /winston/vm-ami for the Vm stack and the EC2
 * VmProvider, and deregisters all but the three newest Winston AMIs
 * (docs/design.md §18). Uses the winston-prod profile unless AWS credentials
 * are already set (as in CI).
 */
import { $ } from "bun";
import {
  buildVersion,
  compileVmBinaries,
  packerEnv,
  run,
} from "./vm-binaries.ts";

export const amiParameter = "/winston/vm-ami";
const keep = 3;

const env = {
  ...packerEnv,
  AWS_REGION: "us-east-1",
  ...(process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE
    ? {}
    : { AWS_PROFILE: "winston-prod" }),
};

const version = buildVersion();
console.log(`Building the Winston AMI with winston and winstond ${version}`);
await compileVmBinaries("x64", version);
await run(["packer", "init", "image"], env);
await run(
  [
    "packer",
    "build",
    "-only=amazon-ebs.ec2",
    "-var",
    "winston_binary=build/winston-linux-x64",
    "-var",
    "winstond_binary=build/winstond-linux-x64",
    "-var",
    `version=${version}`,
    "image",
  ],
  env,
);

const manifest = (await Bun.file("image/build/ami-manifest.json").json()) as {
  builds: { artifact_id: string }[];
};
// "us-east-1:ami-…"
const amiId = manifest.builds.at(-1)?.artifact_id.split(":")[1];
if (!amiId) throw new Error("Packer's manifest names no AMI.");
// `aws:ec2:image`: the type a launch template's `resolve:ssm:` requires.
await $`aws ssm put-parameter --name ${amiParameter} --type String --data-type aws:ec2:image --value ${amiId} --overwrite`
  .env(env)
  .quiet();
console.log(`Recorded ${amiId} in ${amiParameter}.`);

// Old AMIs: running instances don't need theirs, and new ones use the newest.
const images = JSON.parse(
  await $`aws ec2 describe-images --owners self --filters Name=tag:Name,Values=winston-vm --query ${"sort_by(Images,&CreationDate)[].{id:ImageId,snapshots:BlockDeviceMappings[].Ebs.SnapshotId}"} --output json`
    .env(env)
    .text(),
) as { id: string; snapshots: (string | null)[] }[];
for (const image of images.slice(0, -keep)) {
  if (image.id === amiId) continue;
  await $`aws ec2 deregister-image --image-id ${image.id}`.env(env).quiet();
  for (const snapshot of image.snapshots)
    if (snapshot)
      await $`aws ec2 delete-snapshot --snapshot-id ${snapshot}`
        .env(env)
        .quiet();
  console.log(`Deregistered ${image.id} and its snapshots.`);
}
