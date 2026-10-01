/**
 * `bun run deploy`: ships the current commit to production (docs/design.md
 * §8b, docs/runbooks/deploys.md). CI runs it on every push to main after the
 * checks pass and the images are pushed; it also works from a laptop with the
 * winston-prod profile.
 *
 * 1. Every image for this commit must already be in ECR (tagged with its SHA).
 * 2. `cdk deploy --all`: infrastructure changes land first, since new code may
 *    need them. The services don't move yet: their image tag comes from
 *    /winston/image-tag, which still names the running version.
 * 3. Migrations, as a one-off task on the *new* ops image. If they fail, stop:
 *    the old version keeps running.
 * 4. Point /winston/image-tag at this commit and deploy the Services stack
 *    (forced, since only the parameter changed). ECS rolls each service with
 *    the circuit breaker; if anything fails, CloudFormation rolls back and the
 *    parameter is put back.
 * 5. Publish the VM binaries; the gateway offers them to every VM.
 */
import { $ } from "bun";

const env = {
  ...process.env,
  AWS_REGION: "us-east-1",
  ...(process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE
    ? {}
    : { AWS_PROFILE: "winston-prod" }),
};
const images = ["api", "agents", "gateway", "web", "ops"];
const tagParameter = "/winston/image-tag";

const sha =
  process.env.GITHUB_SHA ?? (await $`git rev-parse HEAD`.text()).trim();
const step = (title: string) => {
  console.log(`\n==> ${title}`);
};

step(`Deploying ${sha}`);
for (const image of images) {
  const found =
    await $`aws ecr describe-images --repository-name ${`winston/${image}`} --image-ids ${`imageTag=${sha}`} --query imageDetails[0].imageTags --output text`
      .env(env)
      .quiet()
      .nothrow();
  if (found.exitCode !== 0) {
    console.error(`No winston/${image}:${sha} in ECR; push the images first.`);
    process.exit(1);
  }
}
const previous = (
  await $`aws ssm get-parameter --name ${tagParameter} --query Parameter.Value --output text`
    .env(env)
    .text()
).trim();
console.log(`Production runs ${previous}.`);

step("Infrastructure (cdk deploy --all)");
await $`bunx cdk deploy --all --require-approval never --progress events`
  .cwd("infra")
  .env(env);

step("Migrations, on the new ops image");
await $`bun scripts/prod.ts migrate --yes --image ${sha}`.env(env);

step("Services");
await $`aws ssm put-parameter --name ${tagParameter} --type String --value ${sha} --overwrite`
  .env(env)
  .quiet();
const services =
  await $`bunx cdk deploy Services --exclusively --force --require-approval never --progress events`
    .cwd("infra")
    .env(env)
    .nothrow();
if (services.exitCode !== 0) {
  // CloudFormation has rolled the services back; keep the parameter honest.
  await $`aws ssm put-parameter --name ${tagParameter} --type String --value ${previous} --overwrite`
    .env(env)
    .quiet();
  console.error(
    `The services didn't deploy; rolled back to ${previous}. See docs/runbooks/deploys.md.`,
  );
  process.exit(1);
}

step("VM binaries");
await $`bun scripts/publish-vm-binaries.ts`.env(env);

console.log(`\nDeployed ${sha}.`);
