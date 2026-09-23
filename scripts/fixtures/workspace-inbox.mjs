import assert from "node:assert/strict";
import { spawn, serve } from "bun";
import { randomUUID, createHash } from "node:crypto";
const bytes = Buffer.from("Original attachment");
const transfer = {
  ownerId: process.env.WORKSPACE_OWNER_ID,
  workspaceId: process.env.WORKSPACE_ID,
  workspaceRevision: 1,
  intakeId: randomUUID(),
  artifactId: randomUUID(),
  size: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
};
const token = `wit_${"i".repeat(43)}`;
let checks = 0;
const authority = serve({
  hostname: "127.0.0.1",
  port: 9090,
  async fetch(request) {
    assert.equal(new URL(request.url).pathname, "/api/transfers/inbox/authorize");
    assert.equal(request.headers.get("Authorization"), `Bearer ${token}`);
    assert.deepEqual(await request.json(), transfer);
    checks += 1;
    return Response.json(transfer);
  },
});
const path = `/data/inbox/${transfer.artifactId}`;
try {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch("http://127.0.0.1:8080/v1/inbox", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Winston-Transfer": Buffer.from(JSON.stringify(transfer)).toString("base64url"),
      },
      body: bytes,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { path, size: transfer.size, sha256: transfer.sha256 });
  }
  assert.ok(checks >= 4);
} finally {
  await authority.stop(true);
}
const source = `
  import assert from "node:assert/strict";
  import { readFileSync, writeFileSync, unlinkSync, renameSync, symlinkSync } from "node:fs";
  const path = ${JSON.stringify(path)};
  assert.equal(readFileSync(path, "utf8"), "Original attachment");
  assert.throws(() => writeFileSync(path, "changed"));
  assert.throws(() => unlinkSync(path));
  assert.throws(() => renameSync("/data/inbox", "/data/home/replaced"));
  assert.throws(() => symlinkSync("/data/home", "/data/inbox/redirect"));
`;
const child = spawn(["/usr/local/bin/bun", "-e", source], {
  uid: 1000,
  gid: 1000,
  env: {},
  stdout: "pipe",
  stderr: "pipe",
});
assert.equal(await child.exited, 0, await new Response(child.stderr).text());
console.log("Protected inbox read and mutation boundaries passed.");
