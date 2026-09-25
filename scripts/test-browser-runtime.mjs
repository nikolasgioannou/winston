import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

const endpoint =
  process.env.DOCKER_HOST ??
  execFileSync("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], {
    encoding: "utf8",
  }).trim();
if (!endpoint.startsWith("unix://"))
  throw new Error("Browser tests require a local Docker socket.");
process.env.DOCKER_HOST = endpoint;
const name = `winston-browser-test-${randomUUID()}`;
const runtime = `${name}:runtime`;
const validation = `${name}:validation`;
const volume = `${name}-data`;
const empty = `${name}-empty`;
const identity = ["-e", `BROWSER_OWNER_ID=${randomUUID()}`, "-e", `BROWSER_ID=${randomUUID()}`];
const isolation = [
  "--network",
  "none",
  "--read-only",
  "--tmpfs",
  "/tmp:mode=1777",
  "--shm-size",
  "512m",
  "--memory",
  "2g",
  "--cpus",
  "2",
  "--cap-drop",
  "ALL",
  ...["SETUID", "SETGID", "CHOWN", "DAC_OVERRIDE", "KILL", "SETPCAP"].flatMap((cap) => [
    "--cap-add",
    cap,
  ]),
  "--security-opt",
  "no-new-privileges",
  "--security-opt",
  `seccomp=${resolve("apps/browser/seccomp-profile.json")}`,
];
function docker(...args) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  }).trim();
}
function run(image, storage, args = [], environment = identity) {
  return docker(
    "run",
    "--rm",
    "--name",
    `${name}-operation`,
    ...isolation,
    "--mount",
    `type=volume,source=${storage},target=/data`,
    ...environment,
    "-e",
    "BROWSER_BROKER_SECRET=synthetic-marker",
    image,
    ...args,
  );
}
async function ready() {
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      if (
        docker(
          "exec",
          name,
          "bun",
          "-e",
          'console.log((await fetch("http://127.0.0.1:8080/health")).status)',
        ) === "200"
      )
        return;
    } catch {
      /* The browser is still starting. */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Browser did not become ready.");
}
try {
  for (const [target, image] of [
    ["runtime", runtime],
    ["validation", validation],
  ]) {
    execFileSync(
      "docker",
      ["build", "-f", "apps/browser/Dockerfile", "--target", target, "-t", image, "."],
      { stdio: "inherit", timeout: 600_000 },
    );
  }
  docker("volume", "create", volume);
  docker("volume", "create", empty);
  assert.throws(() => run(runtime, empty), "Missing storage must not initialize itself");
  run(runtime, volume, ["--initialize"]);
  assert.throws(() => run(runtime, volume, ["--initialize"]), "Initialization must be exclusive");
  assert.throws(
    () => run(runtime, volume, [], [...identity, "-e", `BROWSER_ID=${randomUUID()}`]),
    "Foreign browser identity must be rejected",
  );
  const written = JSON.parse(run(validation, volume, ["--write"]));
  const recovered = JSON.parse(run(validation, volume, ["--read"]));
  assert.equal(written.passed, true);
  assert.equal(recovered.passed, true);
  assert.ok(recovered.epoch > written.epoch);

  docker(
    "run",
    "--detach",
    "--name",
    name,
    ...isolation,
    "--mount",
    `type=volume,source=${volume},target=/data`,
    ...identity,
    runtime,
  );
  await ready();
  assert.throws(
    () => run(validation, volume, ["--read"]),
    "A second broker must not open the profile",
  );
  assert.equal(
    docker(
      "exec",
      name,
      "bun",
      "-e",
      'console.log((await fetch("http://127.0.0.1:8080/v1/browser")).status)',
    ),
    "404",
  );
  for (const port of [5900, 6000, 6099, 9222]) {
    const result = docker(
      "exec",
      name,
      "bun",
      "-e",
      `try { const s = await Bun.connect({hostname:"127.0.0.1",port:${port},socket:{data(){}}}); s.end(); console.log("open"); } catch { console.log("closed"); }`,
    );
    assert.equal(result, "closed");
  }
  // Kill the broker rather than PID 1: Tini must exit and container teardown
  // must terminate detached Chromium descendants before the lock can be reused.
  docker("exec", name, "sh", "-c", "kill -KILL $(cat /proc/1/task/1/children)");
  assert.notEqual(docker("wait", name), "0");
  const afterCrash = JSON.parse(run(validation, volume, ["--read"]));
  assert.equal(afterCrash.passed, true);
  assert.ok(afterCrash.epoch > recovered.epoch);
  docker(
    "run",
    "--rm",
    "--name",
    `${name}-operation`,
    ...isolation,
    "--mount",
    `type=volume,source=${volume},target=/data`,
    "--entrypoint",
    "bun",
    runtime,
    "-e",
    'require("node:fs").writeFileSync("/data/profile/SingletonLock", "unexpected file")',
  );
  assert.throws(() => run(runtime, volume), "Unknown lock files must not be deleted or replaced");
  assert.equal(
    docker(
      "run",
      "--rm",
      "--name",
      `${name}-operation`,
      ...isolation,
      "--mount",
      `type=volume,source=${volume},target=/data`,
      "--entrypoint",
      "bun",
      runtime,
      "-e",
      'console.log(require("node:fs").readFileSync("/data/profile/SingletonLock", "utf8"))',
    ),
    "unexpected file",
  );
  console.log(
    "Browser profile persistence, exclusive locking, sandbox identity, secret isolation and crash recovery passed.",
  );
} finally {
  for (const args of [
    ["rm", "--force", name, `${name}-operation`],
    ["volume", "rm", volume, empty],
    ["image", "rm", runtime, validation],
  ]) {
    try {
      docker(...args);
    } catch {
      /* Preserve the original validation error. */
    }
  }
}
