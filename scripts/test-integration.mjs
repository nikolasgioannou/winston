import { execFileSync, spawnSync } from "node:child_process";

const endpoint =
  process.env.DOCKER_HOST ??
  execFileSync("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], {
    encoding: "utf8",
  }).trim();

if (!endpoint.startsWith("unix://")) {
  throw new Error("Integration tests require a local Docker socket, not a remote Docker host.");
}

const result = spawnSync("bun", ["run", "--filter", "@winston/testing", "test:integration"], {
  stdio: "inherit",
  env: {
    ...process.env,
    DOCKER_HOST: endpoint,
    TESTCONTAINERS_HOST_OVERRIDE: "127.0.0.1",
    TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE: "/var/run/docker.sock",
    // This deliberately unusable value proves the helper ignores ambient database credentials.
    DATABASE_URL: "postgres://invalid:invalid@production.invalid:5432/forbidden",
  },
});

if (result.error) {
  throw result.error;
}

process.exitCode = result.status ?? 1;

if (process.exitCode === 0) {
  const workspace = spawnSync(process.execPath, ["scripts/test-workspace-runtime.mjs"], {
    stdio: "inherit",
    env: { ...process.env, DOCKER_HOST: endpoint },
  });
  if (workspace.error) throw workspace.error;
  process.exitCode = workspace.status ?? 1;
}

if (process.exitCode === 0) {
  const browser = spawnSync(process.execPath, ["scripts/test-browser-runtime.mjs"], {
    stdio: "inherit",
    env: { ...process.env, DOCKER_HOST: endpoint },
  });
  if (browser.error) throw browser.error;
  process.exitCode = browser.status ?? 1;
}
