/**
 * The production VM image (docs/design.md §18): the AMI production runs,
 * recorded in /winston/vm-ami, and the commit each AMI was built from, in its
 * `Commit` tag. Shared by the AMI build, which builds one only when a commit
 * needs it, and deploys, which move production onto it.
 */
import { $ } from "bun";

export const amiParameter = "/winston/vm-ami";

type Env = Record<string, string | undefined>;

/** The AMI production runs, or undefined before the first one. */
export async function liveAmi(env: Env) {
  const result =
    await $`aws ssm get-parameter --name ${amiParameter} --query Parameter.Value --output text`
      .env(env)
      .quiet()
      .nothrow();
  if (result.exitCode === 0) return result.text().trim();
  if (result.stderr.toString().includes("ParameterNotFound")) return undefined;
  throw new Error(
    `Reading ${amiParameter} failed: ${result.stderr.toString()}`,
  );
}

/** The newest AMI built from `sha`, if there is one. */
export async function amiForCommit(sha: string, env: Env) {
  const id = (
    await $`aws ec2 describe-images --owners self --filters Name=tag:Name,Values=winston-vm ${`Name=tag:Commit,Values=${sha}`} --query ${"sort_by(Images,&CreationDate)[-1].ImageId"} --output text`
      .env(env)
      .text()
  ).trim();
  return id && id !== "None" ? id : undefined;
}

async function commitOf(ami: string, env: Env) {
  const commit = (
    await $`aws ec2 describe-images --image-ids ${ami} --query ${"Images[0].Tags[?Key=='Commit'].Value | [0]"} --output text`
      .env(env)
      .text()
  ).trim();
  return commit && commit !== "None" ? commit : undefined;
}

/**
 * Why `sha` needs a new VM image, or undefined when the one production runs
 * is still current: image/ hasn't changed since the commit it was built from.
 */
export async function imageChange(sha: string, env: Env) {
  const live = await liveAmi(env);
  if (!live) return "production has no VM image yet";
  const commit = await commitOf(live, env);
  if (!commit) return `${live} doesn't record the commit it was built from`;
  const git = (...args: string[]) => Bun.spawnSync(["git", ...args]).exitCode;
  if (git("merge-base", "--is-ancestor", commit, sha) !== 0)
    return `${live} was built from ${commit}, which isn't in ${sha}'s history`;
  if (git("diff", "--quiet", commit, sha, "--", "image/") !== 0)
    return `image/ changed since ${commit}, which ${live} was built from`;
  return undefined;
}
