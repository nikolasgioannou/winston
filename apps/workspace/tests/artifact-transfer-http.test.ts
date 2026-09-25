import assert from "node:assert/strict";
import { test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { artifactTransferSchema, inboxTransferSchema } from "@winston/contracts/artifacts";
import { createArtifactTransferHandler } from "../src/artifact-transfer-http";
import { createInboxHandler } from "../src/inbox-http";
import { openWorkspaceInbox } from "../src/inbox";

test("artifact receiver binds its own transfer authority and preserves immutable files", async () => {
  const root = mkdtempSync(join(tmpdir(), "winston-artifact-transfer-"));
  mkdirSync(join(root, "control"), { mode: 0o700 });
  const inbox = openWorkspaceInbox(root);
  const slots = { active: 0 };
  const transfer = {
    ownerId: randomUUID(),
    workspaceId: randomUUID(),
    workspaceRevision: 1,
    transferId: randomUUID(),
    artifactId: randomUUID(),
    artifactRevision: 2,
    task: { id: randomUUID(), revision: 3, generation: 4 },
    size: 3,
    sha256: createHash("sha256").update("abc").digest("hex"),
  };
  const token = `wat_${"a".repeat(43)}`;
  let checks = 0;
  let denyPublication = false;
  const handler = createArtifactTransferHandler({
    identity: transfer,
    inbox,
    slots,
    authorize: (credential, input) => {
      assert.equal(credential, token);
      assert.deepEqual(input, transfer);
      checks++;
      return Promise.resolve(!denyPublication || checks === 1);
    },
  });
  const request = (body = "abc", descriptor: unknown = transfer, credential = token) =>
    new Request("http://workspace/v1/artifacts", {
      method: "POST",
      body,
      headers: {
        Authorization: `Bearer ${credential}`,
        "X-Winston-Transfer": Buffer.from(JSON.stringify(descriptor)).toString("base64url"),
      },
    });
  try {
    assert.equal((await handler(request("abc", transfer, `wit_${"a".repeat(43)}`)))?.status, 401);
    assert.equal(
      (await handler(request("abc", { ...transfer, ownerId: randomUUID() })))?.status,
      403,
    );
    assert.equal(
      (await handler(request("abc", { ...transfer, workspaceId: randomUUID() })))?.status,
      403,
    );
    assert.equal(
      (await handler(request("abc", { ...transfer, path: "/data/control/secret" })))?.status,
      400,
    );
    assert.equal(checks, 0);
    for (const body of ["ab", "abcd", "bad"])
      assert.equal((await handler(request(body)))?.status, 503);
    assert.deepEqual(readdirSync(join(root, "inbox")), []);
    checks = 0;
    denyPublication = true;
    assert.equal((await handler(request()))?.status, 503);
    assert.deepEqual(readdirSync(join(root, "inbox")), []);
    assert.equal(slots.active, 0);
    denyPublication = false;
    assert.equal((await handler(request()))?.status, 200);
    assert.equal((await handler(request()))?.status, 200);
    assert.equal(readFileSync(join(root, "inbox", transfer.artifactId), "utf8"), "abc");
    slots.active = 2;
    assert.equal((await handler(request()))?.status, 503);
    const telegram = {
      ownerId: transfer.ownerId,
      workspaceId: transfer.workspaceId,
      workspaceRevision: 1,
      intakeId: randomUUID(),
      artifactId: randomUUID(),
      size: 3,
      sha256: transfer.sha256,
    };
    const telegramHandler = createInboxHandler({
      identity: transfer,
      inbox,
      slots,
      authorize: () => Promise.resolve(true),
    });
    assert.equal(
      (
        await telegramHandler(
          new Request("http://workspace/v1/inbox", {
            method: "POST",
            body: "abc",
            headers: {
              Authorization: `Bearer wit_${"a".repeat(43)}`,
              "X-Winston-Transfer": Buffer.from(JSON.stringify(telegram)).toString("base64url"),
            },
          }),
        )
      )?.status,
      503,
    );
    assert.equal(
      artifactTransferSchema.safeParse({ ...transfer, size: 25 * 1024 * 1024 }).success,
      true,
    );
    assert.equal(
      artifactTransferSchema.safeParse({ ...transfer, size: 50 * 1024 * 1024 + 1 }).success,
      false,
    );
    assert.equal(inboxTransferSchema.safeParse({ ...telegram, size: 20_000_001 }).success, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("artifact inbox accepts Gmail-sized files beyond the Telegram intake ceiling", async () => {
  const root = mkdtempSync(join(tmpdir(), "winston-artifact-large-"));
  mkdirSync(join(root, "control"), { mode: 0o700 });
  try {
    const bytes = Buffer.alloc(20_000_001, 97);
    const id = randomUUID();
    const path = await openWorkspaceInbox(root).publish({
      id,
      bytes,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      authorize: () => Promise.resolve(true),
    });
    assert.equal(path, join(root, "inbox", id));
    assert.equal(readFileSync(path).length, bytes.length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
