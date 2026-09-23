import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import Bun from "bun";

const identity = { ownerId: process.env.WORKSPACE_OWNER_ID, workspaceId: process.env.WORKSPACE_ID };
const worker = randomUUID();
const tokens = {
  execute: `wst_${"a".repeat(43)}`,
  observe: `wst_${"b".repeat(43)}`,
  cancel: `wst_${"c".repeat(43)}`,
};
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const authority = Bun.serve({
  hostname: "127.0.0.1",
  port: 9090,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const mode = path.endsWith("authorize-command")
      ? "execute"
      : path.endsWith("authorize-observe")
        ? "observe"
        : "cancel";
    if (request.headers.get("Authorization") !== `Bearer ${tokens[mode]}`)
      return new Response(null, { status: 403 });
    const input = await request.json();
    if (mode === "execute" && input.dispatch.token !== `wda_${"d".repeat(43)}`)
      return new Response(null, { status: 403 });
    return Response.json({
      version: 1,
      allowed: true,
      operation: mode === "execute" ? input.operation : input,
      workspaceRevision: 1,
    });
  },
});
function command(source) {
  const input = {
    argv: ["bun", "-e", source],
    cwd: "/data/home",
    env: {},
    timeoutMs: 60_000,
    maxOutputBytes: 32768,
  };
  return {
    operation: {
      version: 1,
      identity,
      operationId: randomUUID(),
      taskId: randomUUID(),
      revision: 1,
      generation: 1,
      kind: "command:execute",
      inputHash: createHash("sha256").update(canonical(input)).digest("hex"),
    },
    input,
    dispatch: { id: randomUUID(), token: `wda_${"d".repeat(43)}` },
  };
}
async function send(
  mode,
  body,
  token = tokens[mode === "status" ? "observe" : mode === "cancel" ? "cancel" : "execute"],
) {
  return fetch(`http://127.0.0.1:8080/v1/commands/${mode}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "X-Winston-Worker": worker },
    body: JSON.stringify(body),
  });
}
async function completed(operation) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await send("status", operation);
    assert.equal(response.status, 200);
    const record = await response.json();
    if (record.state !== "running") return record;
    await Bun.sleep(50);
  }
  throw new Error("Command did not complete");
}
try {
  const once = command(
    'const p="/data/home/executions";const n=await Bun.file(p).exists()?Number(await Bun.file(p).text()):0;await Bun.write(p,String(n+1));console.log(process.getuid());',
  );
  assert.equal(
    (await send("start", { ...once, input: { ...once.input, argv: ["false"] } })).status,
    403,
  );
  assert.equal((await send("start", once, tokens.observe)).status, 403);
  assert.equal((await send("start", once)).status, 200);
  const result = await completed(once.operation);
  assert.equal(result.state, "completed");
  assert.equal(JSON.parse(result.outcome.result).stdout.preview.trim(), "1000");
  assert.deepEqual(await (await send("start", once)).json(), result);
  assert.equal(await Bun.file("/data/home/executions").text(), "1");
  const large = command('process.stdout.write("x".repeat(20000))');
  assert.equal((await send("start", large)).status, 200);
  const largeResult = JSON.parse((await completed(large.operation)).outcome.result);
  assert.equal(largeResult.stdout.truncated, true);
  assert.equal(largeResult.stdout.preview.length, 1024);
  assert.equal((await send("stdout", large.operation, tokens.cancel)).status, 403);
  assert.equal(
    (await send("stdout", { ...large.operation, path: "/etc/passwd" }, tokens.observe)).status,
    400,
  );
  const output = await send("stdout", large.operation, tokens.observe);
  assert.equal(output.status, 200);
  const bytes = Buffer.from(await output.arrayBuffer());
  assert.equal(bytes.length, 20000);
  assert.equal(
    output.headers.get("X-Winston-Output-SHA256"),
    createHash("sha256").update(bytes).digest("hex"),
  );
  const long = command("await Bun.sleep(60000)");
  assert.equal((await send("start", long)).status, 200);
  assert.equal((await send("renew", long)).status, 200);
  assert.equal((await send("cancel", long.operation, tokens.observe)).status, 403);
  assert.equal((await send("cancel", long.operation)).status, 200);
  assert.equal(JSON.parse((await completed(long.operation)).outcome.result).reason, "canceled");
  const interrupted = command("await Bun.sleep(60000)");
  assert.equal((await send("start", interrupted)).status, 200);
  console.log(JSON.stringify({ interrupted: interrupted.operation, output: large.operation }));
} finally {
  await authority.stop(true);
}
