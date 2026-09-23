import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

// This creates only disposable resources on the developer or CI host's local Docker engine.
const endpoint =
  process.env.DOCKER_HOST ??
  execFileSync("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], {
    encoding: "utf8",
  }).trim();
if (!endpoint.startsWith("unix://"))
  throw new Error("Workspace tests require a local Docker socket.");
process.env.DOCKER_HOST = endpoint;
const name = `winston-runtime-test-${randomUUID()}`;
const image = process.argv[2] ?? name;
const volume = `${name}-data`;
const empty = `${name}-empty`;
const ownerId = randomUUID();
const workspaceId = randomUUID();
const environment = [
  "-e",
  `WORKSPACE_OWNER_ID=${ownerId}`,
  "-e",
  `WORKSPACE_ID=${workspaceId}`,
  "-e",
  "WORKSPACE_AUTHORITY_ORIGIN=http://127.0.0.1:9090",
];

function docker(...arguments_) {
  return execFileSync("docker", arguments_, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function run(storage, ...arguments_) {
  return docker(
    "run",
    "--rm",
    "--mount",
    `type=volume,source=${storage},target=/data`,
    ...environment,
    image,
    ...arguments_,
  );
}

function evaluate(source, user = "0") {
  return docker("exec", "--user", user, name, "bun", "-e", source);
}

async function ready() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      if (
        evaluate(
          'const r = await fetch("http://127.0.0.1:8080/health"); console.log(r.status);',
        ) === "200"
      )
        return;
    } catch {
      // The service may still be taking ownership and opening its journal.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Workspace did not become healthy.");
}

try {
  if (!process.argv[2]) {
    execFileSync("docker", ["build", "-f", "apps/workspace/Dockerfile", "-t", image, "."], {
      stdio: "inherit",
    });
  }
  execFileSync(
    "docker",
    [
      "run",
      "--rm",
      "--name",
      `${name}-commands`,
      "--interactive",
      "--network",
      "none",
      "--read-only",
      "--tmpfs",
      "/tmp",
      "--cap-add",
      "SYS_ADMIN",
      "--security-opt",
      "no-new-privileges",
      "--security-opt",
      "apparmor=unconfined",
      "--entrypoint",
      "bun",
      image,
      "run",
      "-",
    ],
    {
      input: readFileSync("scripts/fixtures/workspace-commands.mjs"),
      stdio: ["pipe", "inherit", "inherit"],
      timeout: 30_000,
    },
  );
  docker("volume", "create", volume);
  docker("volume", "create", empty);
  assert.throws(() => run(empty), "Missing storage must not initialize itself.");
  run(volume, "--initialize");
  assert.throws(() => run(volume, "--initialize"), "Initialization must be exclusive.");
  docker(
    "run",
    "--detach",
    "--name",
    name,
    "--read-only",
    "--tmpfs",
    "/tmp",
    "--network",
    "none",
    "--cap-add",
    "SYS_ADMIN",
    "--security-opt",
    "no-new-privileges",
    "--security-opt",
    "apparmor=unconfined",
    "--mount",
    `type=volume,source=${volume},target=/data`,
    ...environment,
    image,
  );
  await ready();

  const commandFixture = JSON.parse(
    evaluate(readFileSync("scripts/fixtures/workspace-command-http.mjs", "utf8")),
  );

  assert.throws(
    () => docker("exec", name, "/usr/local/bin/workspace-entrypoint"),
    "A second runtime must not acquire the lock.",
  );
  evaluate('await Bun.write("/data/home/persistent.txt", "retained");', "1000:1000");
  for (const source of [
    'await Bun.file("/data/control/operations.sqlite").text();',
    'await Bun.write("/app/main.js", "modified");',
    'await Bun.write("/data/.runtime.lock", "modified");',
    'await Bun.write("/data/control/injected", "modified");',
  ]) {
    assert.throws(() => evaluate(source, "1000:1000"), "Execution user reached protected state.");
  }

  const operation = {
    version: 1,
    identity: { ownerId, workspaceId },
    operationId: randomUUID(),
    taskId: randomUUID(),
    revision: 0,
    generation: 1,
    kind: "workspace:inspect",
    inputHash: "a".repeat(64),
  };
  const serialized = JSON.stringify(operation);
  evaluate(
    `const { Database } = await import("bun:sqlite"); const db = new Database("/data/control/operations.sqlite"); db.query("INSERT INTO operations (id, request, state, completion_token) VALUES (?, ?, 'running', ?)").run(${JSON.stringify(operation.operationId)}, ${JSON.stringify(serialized)}, "interrupted"); db.close();`,
  );
  docker("kill", name);
  docker("start", name);
  await ready();
  assert.equal(
    evaluate(
      `const {Database}=await import("bun:sqlite");const db=new Database("/data/control/operations.sqlite");console.log(db.query("SELECT state FROM operations WHERE id = ?").get(${JSON.stringify(commandFixture.interrupted.operationId)}).state);db.close();`,
    ),
    "unknown",
  );
  assert.equal(
    evaluate(`
    const operation = ${JSON.stringify(commandFixture.output)};
    const authority = Bun.serve({hostname:"127.0.0.1",port:9090,fetch:()=>Response.json({version:1,allowed:true,operation,workspaceRevision:1})});
    try {
      const response = await fetch("http://127.0.0.1:8080/v1/commands/stdout",{method:"POST",headers:{Authorization:"Bearer wst_${"a".repeat(43)}","X-Winston-Worker":"${randomUUID()}"},body:JSON.stringify(operation)});
      if(response.status!==200) throw new Error("Persisted output unavailable");
      const body = new Uint8Array(await response.arrayBuffer());
      const {createHash}=await import("node:crypto");
      if(createHash("sha256").update(body).digest("hex")!==response.headers.get("X-Winston-Output-SHA256")) throw new Error("Persisted output changed");
      console.log(body.byteLength);
    } finally { await authority.stop(true); }
  `),
    "20000",
  );
  assert.equal(
    evaluate('console.log(await Bun.file("/data/home/persistent.txt").text());', "1000:1000"),
    "retained",
  );
  assert.equal(
    evaluate(
      `const { Database } = await import("bun:sqlite"); const db = new Database("/data/control/operations.sqlite"); console.log(db.query("SELECT state FROM operations WHERE id = ?").get(${JSON.stringify(operation.operationId)}).state); db.close();`,
    ),
    "unknown",
  );
  docker("stop", name);
  assert.throws(
    () =>
      docker(
        "run",
        "--rm",
        "--mount",
        `type=volume,source=${volume},target=/data`,
        ...environment,
        "-e",
        `WORKSPACE_OWNER_ID=${randomUUID()}`,
        image,
      ),
    "Foreign volume identity must be rejected.",
  );
  console.log(
    "Linux workspace ownership, privilege boundaries, crash recovery and persistence passed.",
  );
} finally {
  for (const arguments_ of [
    ["rm", "--force", name],
    ["rm", "--force", `${name}-commands`],
    ["volume", "rm", volume, empty],
    ...(!process.argv[2] ? [["image", "rm", image]] : []),
  ]) {
    try {
      docker(...arguments_);
    } catch {
      /* Preserve the original validation error. */
    }
  }
}
