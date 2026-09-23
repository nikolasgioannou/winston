import assert from "node:assert/strict";
import { test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWorkspaceInbox } from "../src/inbox";

test("inbox publication verifies bytes, authorizes at commit and preserves immutable identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "winston-inbox-"));
  mkdirSync(join(root, "control"), { mode: 0o700 });
  try {
    const inbox = openWorkspaceInbox(root);
    const input = {
      id: randomUUID(),
      bytes: Buffer.from("fixture"),
      size: 7,
      sha256: createHash("sha256").update("fixture").digest("hex"),
      authorize: () => Promise.resolve(true),
    };
    await assert.rejects(inbox.publish({ ...input, size: 8 }));
    await assert.rejects(inbox.publish({ ...input, sha256: "0".repeat(64) }));
    await assert.rejects(inbox.publish({ ...input, authorize: () => Promise.resolve(false) }));
    assert.deepEqual(readdirSync(join(root, "inbox")), []);
    assert.deepEqual(readdirSync(join(root, "control", "inbox-pending")), []);
    const paths = await Promise.all([inbox.publish(input), inbox.publish(input)]);
    assert.equal(paths[0], paths[1]);
    assert.equal(readFileSync(paths[0], "utf8"), "fixture");
    assert.equal(await openWorkspaceInbox(root).publish(input), paths[0]);
    await assert.rejects(
      inbox.publish({
        ...input,
        bytes: Buffer.from("changed"),
        sha256: createHash("sha256").update("changed").digest("hex"),
      }),
    );
    const hostile = randomUUID();
    symlinkSync(paths[0], join(root, "inbox", hostile));
    await assert.rejects(inbox.publish({ ...input, id: hostile }));
    assert.equal(readFileSync(paths[0], "utf8"), "fixture");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
