import { execFileSync } from "node:child_process";

const unstaged = execFileSync("git", ["diff", "--name-only", "-z"], { encoding: "utf8" });
const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
  encoding: "utf8",
});

if (unstaged || untracked) {
  console.error(
    "Stage the intended changes and stash any remaining edits or untracked files before committing. " +
      "Checks must run against the same files that will be committed. No files were changed or staged.",
  );

  process.exitCode = 1;
}
