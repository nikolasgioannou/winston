import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname } from "node:path";

const textExtensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".html",
  ".css",
  ".yml",
  ".yaml",
  ".toml",
  ".swift",
]);

const textNames = new Set([
  ".editorconfig",
  ".gitattributes",
  ".gitignore",
  ".prettierignore",
  "bun.lock",
]);

const paths = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  {
    encoding: "utf8",
  },
)
  .split("\0")
  .filter(Boolean);

const failures = [];

for (const path of paths) {
  if (!textExtensions.has(extname(path)) && !textNames.has(path)) {
    continue;
  }

  let contents;

  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    // An unstaged deletion is still returned by git ls-files.
    if (error.code === "ENOENT") {
      continue;
    }

    throw error;
  }

  if (contents.includes("\r")) {
    failures.push(`${path}: use LF line endings`);
  }

  if (contents && !contents.endsWith("\n")) {
    failures.push(`${path}: add a final newline`);
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
}
