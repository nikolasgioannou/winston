import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { parseCommand } from "../src/parse";

test("attachment capture requires an explicit MIME part and stable approval key", () => {
  const accountId = randomUUID();
  const args = ["gmail", "attachment", "--account", accountId, "--id", "message1"];
  assert.throws(() => parseCommand(args));
  assert.throws(() => parseCommand([...args, "--part", "0"]));
  assert.throws(() => parseCommand([...args, "--key", "capture"]));
  const parsed = parseCommand([...args, "--part", "", "--key", "capture"]);
  assert.equal(parsed.kind, "request");
  assert.deepEqual(parsed.request, {
    version: 1,
    command: "gmail.attachment",
    accountId,
    id: "message1",
    partId: "",
    key: "capture",
  });
  assert.throws(() =>
    parseCommand([...args, "--part", "0", "--key", "capture", "--path", "/tmp/file"]),
  );
});
