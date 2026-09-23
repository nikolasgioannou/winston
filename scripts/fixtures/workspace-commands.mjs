import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  chownSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { createCommandRunner } from "/app/processes.js";

const root = mkdtempSync("/tmp/winston-commands-");
chmodSync(root, 0o755);
const home = join(root, "home");
const control = join(root, "control");
mkdirSync(home, { mode: 0o700 });
chownSync(home, 1000, 1000);
mkdirSync(control, { mode: 0o700 });
const logsRoot = join(control, "commands");
const runner = createCommandRunner({ home, logsRoot, supervisorPath: "/app/supervisor.js" });
const input = (argv, overrides = {}) => ({
  argv,
  cwd: home,
  env: {},
  timeoutMs: 5000,
  maxOutputBytes: 1_000_000,
  ...overrides,
});
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

try {
  process.env.WINSTON_SYNTHETIC_SECRET = "must-not-inherit";
  const identity = await runner.start(
    randomUUID(),
    input([
      "/bin/sh",
      "-c",
      "id -u; id -G; printf '%s' \"${WINSTON_SYNTHETIC_SECRET-unset}\"; cat /proc/self/status | /bin/grep NoNewPrivs",
    ]),
  ).result;
  assert.equal(identity.reason, "exited");
  assert.equal(identity.exitCode, 0);
  assert.match(identity.stdout.preview, /^1000\n1000\nunsetNoNewPrivs:\s+1/m);

  const id = randomUUID();
  const complete = runner.start(
    id,
    input([
      "/usr/local/bin/bun",
      "-e",
      "process.stdout.write('x'.repeat(20000)); process.stderr.write('diagnostic'); process.exit(7)",
    ]),
  );
  assert.throws(() => runner.start(id, input(["/bin/true"])));
  const output = await complete.result;
  assert.equal(output.reason, "exited");
  assert.equal(output.exitCode, 7);
  assert.equal(output.stdout.bytes, 20000);
  assert.equal(output.stdout.preview.length, 1024);
  assert.equal(output.stdout.truncated, true);
  assert.equal(output.stderr.preview, "diagnostic");
  const full = readFileSync(join(logsRoot, id, "stdout"));
  assert.equal(full.length, 20000);
  assert.equal(output.stdout.sha256, createHash("sha256").update(full).digest("hex"));
  assert.throws(() => runner.start(id, input(["/bin/true"])));
  assert.throws(() => runner.start(randomUUID(), input(["/bin/true"], { cwd: "/app" })));
  const denied = await runner.start(randomUUID(), input(["/bin/cat", join(logsRoot, id, "stdout")]))
    .result;
  assert.notEqual(denied.exitCode, 0);
  assert.equal(denied.stdout.bytes, 0);

  const canceled = runner.start(
    randomUUID(),
    input([
      "/bin/sh",
      "-c",
      "touch started; setsid /bin/sh -c 'sleep 1; touch escaped' & sleep 30",
    ]),
  );
  for (let attempt = 0; attempt < 100 && !existsSync(join(home, "started")); attempt++)
    await wait(20);
  assert.ok(existsSync(join(home, "started")));
  const unrelated = runner.start(
    randomUUID(),
    input(["/bin/sh", "-c", "sleep 0.3; printf unaffected"]),
  );
  canceled.cancel();
  assert.equal((await canceled.result).reason, "canceled");
  assert.equal((await unrelated.result).stdout.preview, "unaffected");
  await wait(1200);
  assert.equal(existsSync(join(home, "escaped")), false);

  const exited = await runner.start(
    randomUUID(),
    input(["/bin/sh", "-c", "setsid /bin/sh -c 'sleep 1; touch orphan' & exit 0"]),
  ).result;
  assert.equal(exited.exitCode, 0);
  await wait(1200);
  assert.equal(existsSync(join(home, "orphan")), false);
  const timeout = await runner.start(
    randomUUID(),
    input(["/bin/sh", "-c", "trap '' TERM; sleep 30"], { timeoutMs: 200 }),
  ).result;
  assert.equal(timeout.reason, "timeout");
  const noisy = await runner.start(
    randomUUID(),
    input(["/usr/bin/yes", "noise"], { maxOutputBytes: 4096 }),
  ).result;
  assert.equal(noisy.reason, "output_limit");
  assert.equal(noisy.stdout.bytes + noisy.stderr.bytes, 4096);
  assert.equal(noisy.stdout.truncated, true);
  const pending = Array.from({ length: 4 }, () =>
    runner.start(randomUUID(), input(["/bin/sleep", "30"])),
  );
  assert.throws(() => runner.start(randomUUID(), input(["/bin/true"])));
  await runner.close();
  for (const handle of pending) assert.equal((await handle.result).reason, "canceled");
  assert.throws(() => runner.start(randomUUID(), input(["/bin/true"])));
  console.log(
    "Command UID, groups, environment, output integrity, duplicate prevention, detached descendants, cancellation, deadlines and output limits passed.",
  );
} finally {
  await runner.close();
  rmSync(root, { recursive: true, force: true });
}
