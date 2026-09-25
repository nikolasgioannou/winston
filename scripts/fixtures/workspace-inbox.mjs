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
const artifact = {
  ownerId: transfer.ownerId,
  workspaceId: transfer.workspaceId,
  workspaceRevision: 1,
  transferId: randomUUID(),
  artifactId: randomUUID(),
  artifactRevision: 1,
  task: { id: randomUUID(), revision: 2, generation: 3 },
  size: bytes.length,
  sha256: transfer.sha256,
};
const artifactToken = `wat_${"a".repeat(43)}`;
let checks = 0;
const authority = serve({
  hostname: "127.0.0.1",
  port: 9090,
  async fetch(request) {
    const pathname = new URL(request.url).pathname;
    assert.ok(
      ["/api/transfers/inbox/authorize", "/api/transfers/artifacts/authorize"].includes(pathname),
    );
    const incoming = pathname === "/api/transfers/inbox/authorize";
    const expected = incoming ? transfer : artifact;
    assert.equal(
      request.headers.get("Authorization"),
      `Bearer ${incoming ? token : artifactToken}`,
    );
    assert.deepEqual(await request.json(), expected);
    checks += 1;
    return Response.json(expected);
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
    const staged = await fetch("http://127.0.0.1:8080/v1/artifacts", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${artifactToken}`,
        "X-Winston-Transfer": Buffer.from(JSON.stringify(artifact)).toString("base64url"),
      },
      body: bytes,
    });
    assert.equal(staged.status, 200);
    assert.deepEqual(await staged.json(), {
      path: `/data/inbox/${artifact.artifactId}`,
      size: artifact.size,
      sha256: artifact.sha256,
    });
  }
  assert.ok(checks >= 8);
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
  const artifactPath = ${JSON.stringify(`/data/inbox/${artifact.artifactId}`)};
  assert.equal(readFileSync(artifactPath, "utf8"), "Original attachment");
  assert.throws(() => writeFileSync(artifactPath, "changed"));
  assert.throws(() => unlinkSync(artifactPath));
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
