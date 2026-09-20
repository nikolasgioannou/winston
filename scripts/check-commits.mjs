import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function requireSha(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) {
    throw new Error("Expected a full commit SHA in the GitHub event.");
  }

  return value;
}

export function commitsForEvent(event, directory = process.cwd()) {
  const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
  const head = requireSha(event.pull_request?.head?.sha ?? event.after ?? git("rev-parse", "HEAD"));
  const base = event.pull_request?.base?.sha ?? event.before;
  let range = head;

  if (base !== undefined && !/^0{40}$/.test(requireSha(base))) {
    const exists = spawnSync("git", ["cat-file", "-e", `${base}^{commit}`], { cwd: directory });

    if (exists.status === 0) {
      range = `${base}..${head}`;
    } else if (event.pull_request) {
      throw new Error("Pull request base is missing; fetch the complete history before checking.");
    }
    // After a force push, the old base may be unreachable. Check the new history in full.
  }

  return git("rev-list", "--reverse", range).split("\n").filter(Boolean);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const event = process.env.GITHUB_EVENT_PATH
    ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"))
    : {};
  const cli = fileURLToPath(import.meta.resolve("@commitlint/cli/cli.js"));

  for (const sha of commitsForEvent(event)) {
    const message = execFileSync("git", ["show", "-s", "--format=%B", sha], { encoding: "utf8" });
    const result = spawnSync(process.execPath, [cli], {
      input: message,
      encoding: "utf8",
    });

    if (result.error) {
      throw result.error;
    }

    if (result.status !== 0) {
      console.error(`Invalid commit message: ${sha}\n${result.stdout}${result.stderr}`);
      process.exitCode = result.status ?? 1;
      break;
    }
  }
}
