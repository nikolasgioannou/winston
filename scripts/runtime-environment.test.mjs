import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("backend bundles use the runtime environment, not the build environment", () => {
  const directory = mkdtempSync(join(tmpdir(), "winston-runtime-environment-"));
  const fixture = join(directory, "fixture.ts");
  writeFileSync(
    fixture,
    'console.log(process.env.NODE_ENV === "production" ? "production" : "local");\n',
  );

  try {
    for (const app of ["server", "workspace", "cli"]) {
      const manifest = JSON.parse(
        readFileSync(new URL(`../apps/${app}/package.json`, import.meta.url), "utf8"),
      );
      const envOption = manifest.scripts.build.match(/--env=\S+/)?.[0];
      assert.equal(
        envOption,
        "--env=disable",
        `${app} must preserve runtime environment variables`,
      );
      const output = join(directory, `${app}.js`);
      execFileSync("bun", ["build", fixture, "--target=bun", envOption, `--outfile=${output}`], {
        env: { ...process.env, NODE_ENV: "development" },
        stdio: "pipe",
      });

      for (const [environment, expected] of [
        ["production", "production"],
        ["development", "local"],
      ]) {
        const actual = execFileSync("bun", [output], {
          env: { ...process.env, NODE_ENV: environment },
          encoding: "utf8",
        });
        assert.equal(actual.trim(), expected, `${app}: ${environment}`);
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
