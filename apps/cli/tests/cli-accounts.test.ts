import assert from "node:assert/strict";
import { test } from "bun:test";
import { parseCommand } from "../src/parse";
import { help } from "../src/commands";

test("account discovery commands require explicit identities and strict options", () => {
  const id = "71bc985c-00bc-46ca-94a1-ad6ed8c739a3";
  const inspected = parseCommand(["accounts", "inspect", "--id", id]);
  assert.equal(inspected.kind, "request");
  assert.deepEqual(inspected.request, { version: 1, command: "accounts.inspect", id });
  const resolved = parseCommand(["accounts", "resolve", "--service", "gmail", "--alias", " Work "]);
  assert.equal(resolved.kind, "request");
  assert.deepEqual(resolved.request, {
    version: 1,
    command: "accounts.resolve",
    service: "gmail",
    alias: "Work",
  });
  for (const args of [
    ["accounts", "resolve", "--alias", "Work"],
    ["accounts", "resolve", "--service", "gmail"],
    ["accounts", "resolve", "--service", "gmail", "--alias", " "],
    ["accounts", "resolve", "--service", "gmail", "--alias", "Work", "--id", id],
    ["accounts", "inspect", "--id", "Work"],
    ["accounts", "list", "--alias", "Work"],
  ])
    assert.throws(() => parseCommand(args));
  assert.match(JSON.stringify(help("accounts")), /accounts resolve/);
});
