import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export async function deploymentIsCurrent({ repository, sha, token }, request = fetch) {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "") ||
    !/^[0-9a-f]{40}$/.test(sha ?? "") ||
    typeof token !== "string" ||
    !token
  ) {
    throw new Error("Deployment verification requires a repository, commit SHA and read token.");
  }

  let response;
  try {
    response = await request(`https://api.github.com/repos/${repository}/git/ref/heads/main`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2026-03-10",
      },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error("Could not verify the current deployment revision.");
  }
  if (!response.ok) throw new Error("GitHub rejected the deployment revision check.");

  let reference;
  try {
    reference = await response.json();
  } catch {
    throw new Error("GitHub returned an invalid deployment reference.");
  }
  if (
    reference?.ref !== "refs/heads/main" ||
    reference?.object?.type !== "commit" ||
    !/^[0-9a-f]{40}$/.test(reference?.object?.sha ?? "")
  ) {
    throw new Error("GitHub returned an invalid deployment reference.");
  }
  return reference.object.sha === sha;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (
    process.env.GITHUB_EVENT_NAME !== "push" ||
    process.env.GITHUB_REF !== "refs/heads/main" ||
    !process.env.GITHUB_OUTPUT
  ) {
    throw new Error("Deployment verification must run in the main-branch push workflow.");
  }
  const current = await deploymentIsCurrent({
    repository: process.env.GITHUB_REPOSITORY,
    sha: process.env.GITHUB_SHA,
    token: process.env.GITHUB_TOKEN,
  });
  appendFileSync(process.env.GITHUB_OUTPUT, `current=${String(current)}\n`);
  console.log(
    current
      ? "Verified commit is current on main."
      : "Skipping deployment: the verified commit has been superseded on main.",
  );
}
