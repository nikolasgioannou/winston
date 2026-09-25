import assert from "node:assert/strict";
import { test } from "bun:test";
import { parseCommand } from "../src/parse";

const accountId = "11111111-1111-4111-8111-111111111111";
test("Trash CLI accepts an exact account, message and stable key only", () => {
  for (const kind of ["trash", "restore"]) {
    const args = ["gmail", kind, "--account", accountId, "--id", "m1", "--key", "change"];
    const parsed = parseCommand(args);
    assert.equal(parsed.kind, "request");
    assert.deepEqual(parsed.request, {
      version: 1,
      command: `gmail.${kind}`,
      accountId,
      messageId: "m1",
      key: "change",
    });
    for (const extra of [
      ["--query", "all"],
      ["--add-labels", '["INBOX"]'],
      ["--id", "m2"],
    ])
      assert.throws(() => parseCommand([...args, ...extra]));
    assert.throws(() => parseCommand(args.slice(0, -2)));
  }
  assert.throws(() =>
    parseCommand(["gmail", "delete", "--account", accountId, "--id", "m1", "--key", "change"]),
  );
});
