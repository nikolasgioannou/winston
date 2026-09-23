import assert from "node:assert/strict";
import { spawn } from "bun";
import { randomUUID, createHash } from "node:crypto";
import { openWorkspaceInbox } from "/app/inbox.js";

const inbox = openWorkspaceInbox("/data");
const bytes = Buffer.from("Original attachment");
const path = await inbox.publish({
  id: randomUUID(),
  size: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  bytes,
  authorize: () => Promise.resolve(true),
});
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
