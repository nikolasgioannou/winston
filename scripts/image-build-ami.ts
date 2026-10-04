/**
 * `bun run image:build:ami [--force]`: builds the production AMI for the
 * current commit when it needs one (docs/design.md §18): when image/ changed
 * since the commit the AMI production runs was built from. `--force` builds
 * anyway (say, for the base image's updates). Deploys run it, and only a
 * deploy moves production onto the new AMI (scripts/deploy.ts).
 *
 * It compiles the winston CLI and winstond for linux-x64, builds the AMI from
 * image/winston.pkr.hcl (the same provisioning as the local image, plus the
 * EC2-only steps), tags it with the commit, and deregisters all but the three
 * newest Winston AMIs, never the one production runs. Uses the winston-prod
 * profile unless AWS credentials are already set (as in CI).
 */
import {
  buildVersion,
  compileVmBinaries,
  packerEnv,
  run,
} from "./vm-binaries.ts";
import { $ } from "bun";
import { amiForCommit, imageChange, liveAmi } from "./vm-image.ts";

const keep = 3;

const env = {
  ...packerEnv,
  AWS_REGION: "us-east-1",
  ...(process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE
    ? {}
    : { AWS_PROFILE: "winston-prod" }),
};

const force = process.argv.includes("--force");
const sha =
  process.env.GITHUB_SHA ?? (await $`git rev-parse HEAD`.text()).trim();
const version = buildVersion();
// A build with uncommitted changes isn't that commit's image, so no deploy
// picks it up.
const commit = version.endsWith(".dirty") ? `${sha}.dirty` : sha;

if (!force) {
  const built = await amiForCommit(commit, env);
  if (built) {
    console.log(`${built} is already built from ${sha}.`);
    process.exit(0);
  }
  const reason = await imageChange(sha, env).catch((error: unknown) => {
    // The first deploy after this change runs before cdk lets this role read
    // the parameter: building is the safe answer.
    console.warn(String(error));
    return "it couldn't tell whether image/ changed";
  });
  if (!reason) {
    console.log("image/ hasn't changed since production's VM image: no build.");
    process.exit(0);
  }
  console.log(`Building, since ${reason}.`);
}

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
    "-var",
    `commit=${commit}`,
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
console.log(
  `Built ${amiId} from ${commit}; a deploy moves production onto it.`,
);

// Old AMIs: running instances don't need theirs, and new ones launch from the
// one production runs, which is kept.
const live = await liveAmi(env).catch(() => undefined);
const images = JSON.parse(
  await $`aws ec2 describe-images --owners self --filters Name=tag:Name,Values=winston-vm --query ${"sort_by(Images,&CreationDate)[].{id:ImageId,snapshots:BlockDeviceMappings[].Ebs.SnapshotId}"} --output json`
    .env(env)
    .text(),
) as { id: string; snapshots: (string | null)[] }[];
for (const image of images.slice(0, -keep)) {
  if (image.id === amiId || image.id === live || !live) continue;
  await $`aws ec2 deregister-image --image-id ${image.id}`.env(env).quiet();
  for (const snapshot of image.snapshots)
    if (snapshot)
      await $`aws ec2 delete-snapshot --snapshot-id ${snapshot}`
        .env(env)
        .quiet();
  console.log(`Deregistered ${image.id} and its snapshots.`);
}
