import assert from "node:assert/strict";
import { test } from "bun:test";
import { parseCommand } from "../src/parse";

const accountId = "11111111-1111-4111-8111-111111111111";
test("Gmail label discovery has an explicit account and optional stable read key", () => {
  const parsed = parseCommand([
    "gmail",
    "labels",
    "--account",
    accountId,
    "--key",
    "labels",
    "--json",
  ]);
  assert.equal(parsed.kind, "request");
  assert.deepEqual(parsed.request, {
    version: 1,
    command: "gmail.labels",
    accountId,
    key: "labels",
  });
  assert.equal(parsed.json, true);
  for (const args of [
    ["gmail", "labels"],
    ["gmail", "labels", "--account", accountId, "--query", "partial"],
    ["gmail", "labels", "--account", accountId, "--id", "label1"],
    ["gmail", "labels", "--account", accountId, "--key", "one", "--key", "two"],
  ]) {
    assert.throws(() => parseCommand(args));
  }
});
