import assert from "node:assert/strict";
import { test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createInboxHandler } from "../src/inbox-http";
import { openWorkspaceInbox } from "../src/inbox";

test("binary inbox checks identity, authority, exact bytes and authority again before publication", async () => {
  const root = mkdtempSync(join(tmpdir(), "winston-inbox-http-"));
  mkdirSync(join(root, "control"), { mode: 0o700 });
  try {
    const transfer = {
      ownerId: randomUUID(),
      workspaceId: randomUUID(),
      intakeId: randomUUID(),
      workspaceRevision: 1,
      artifactId: randomUUID(),
      size: 3,
      sha256: createHash("sha256").update("abc").digest("hex"),
    };
    const token = `wit_${"a".repeat(43)}`;
    let authorizations = 0;
    let denyPublication = false;
    const handler = createInboxHandler({
      identity: transfer,
      inbox: openWorkspaceInbox(root),
      authorize: (credential, input) => {
        assert.equal(credential, token);
        assert.deepEqual(input, transfer);
        authorizations += 1;
        return Promise.resolve(!denyPublication || authorizations === 1);
      },
    });
    const request = (body = "abc", descriptor = transfer, credential = token) =>
      new Request("http://workspace/v1/inbox", {
        method: "POST",
        body,
        headers: {
          Authorization: `Bearer ${credential}`,
          "X-Winston-Transfer": Buffer.from(JSON.stringify(descriptor)).toString("base64url"),
        },
      });
    assert.equal((await handler(request("abc", transfer, "bad")))?.status, 401);
    assert.equal(
      (await handler(request("abc", { ...transfer, ownerId: randomUUID() })))?.status,
      403,
    );
    assert.equal(authorizations, 0);
    assert.equal((await handler(request("abcd")))?.status, 503);
    assert.equal((await handler(request("ab")))?.status, 503);
    assert.equal((await handler(request("bad")))?.status, 503);
    assert.deepEqual(readdirSync(join(root, "inbox")), []);
    authorizations = 0;
    denyPublication = true;
    assert.equal((await handler(request()))?.status, 503);
    assert.equal(authorizations, 2);
    assert.deepEqual(readdirSync(join(root, "inbox")), []);
    denyPublication = false;
    assert.equal((await handler(request()))?.status, 200);
    assert.equal((await handler(request()))?.status, 200);
    assert.equal(readFileSync(join(root, "inbox", transfer.artifactId), "utf8"), "abc");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
