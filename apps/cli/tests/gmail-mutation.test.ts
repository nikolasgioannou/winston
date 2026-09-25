import assert from "node:assert/strict";
import { test } from "bun:test";
import { cliGmailMutationRequestSchema, gmailMutationInputFromCli } from "@winston/contracts/cli";
import { parseCommand } from "../src/parse";
import { callGateway } from "../src/gateway";
import { runCli } from "../src/run";

const accountId = "11111111-1111-4111-8111-111111111111";
const message = {
  from: { email: "owner@example.com" },
  to: [{ email: "guest@example.com" }],
  cc: [],
  bcc: [{ email: "private@example.com" }],
  subject: "Review",
  text: "Exact\nbody",
  html: null,
  reply: null,
  attachments: [],
};
const base = ["--account", accountId, "--key", "message", "--message", JSON.stringify(message)];

test("Gmail CLI preserves exact content and separate draft and message identities", () => {
  for (const [command, kind] of [
    ["draft-create", "draft.create"],
    ["draft-update", "draft.update"],
    ["send", "message.send"],
    ["draft-send", "draft.send"],
  ] as const) {
    const existing = command === "draft-update" || command === "draft-send";
    const parsed = parseCommand([
      "gmail",
      command,
      ...base,
      ...(existing ? ["--id", "draft1", "--message-id", "message1"] : []),
      "--json",
    ]);
    assert.equal(parsed.kind, "request");
    assert.equal(parsed.json, true);
    assert.deepEqual(
      gmailMutationInputFromCli(cliGmailMutationRequestSchema.parse(parsed.request)),
      {
        key: "message",
        intent: {
          kind,
          accountId,
          message,
          ...(existing ? { draftId: "draft1", expectedMessageId: "message1" } : {}),
        },
      },
    );
    const help = parseCommand(["gmail", command, "--help"]);
    assert.equal(help.kind, "help");
    assert.match(JSON.stringify(help.content), /attachments/);
  }
});

test("Gmail CLI rejects missing versions, ambiguous flags and raw message escape hatches", () => {
  for (const args of [
    ["gmail", "send", ...base.slice(2)],
    ["gmail", "send", ...base.slice(0, 2), ...base.slice(4)],
    ["gmail", "send", ...base, "--key", "other"],
    ["gmail", "send", ...base, "--id", "draft1"],
    ["gmail", "draft-update", ...base, "--id", "draft1"],
    ["gmail", "draft-send", ...base, "--message-id", "message1"],
    ["gmail", "send", ...base.slice(0, -1), "not-json"],
    ["gmail", "send", ...base.slice(0, -1), JSON.stringify({ ...message, raw: "bypass" })],
    ["gmail", "send", ...base, "--path", "/tmp/message"],
  ]) {
    assert.throws(() => parseCommand(args));
  }
});

test("Gmail CLI requires control authority and does not retry a lost write response", async () => {
  const parsed = parseCommand(["gmail", "send", ...base]);
  assert.equal(parsed.kind, "request");
  const authority = {
    version: 1 as const,
    environment: "local" as const,
    workspaceId: accountId,
    token: `wst_${"r".repeat(43)}`,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const controlToken = `wst_${"c".repeat(43)}`;
  let calls = 0;
  const send = (url: string, init: RequestInit) => {
    calls++;
    assert.equal(url, "http://127.0.0.1:3001/api/tasks/cli/control");
    assert.equal(new Headers(init.headers).get("Authorization"), `Bearer ${controlToken}`);
    assert.equal(init.redirect, "error");
    assert.ok(typeof init.body === "string");
    assert.deepEqual(JSON.parse(init.body), parsed.request);
    return Promise.reject(new Error("Lost response"));
  };
  assert.equal((await callGateway(authority, parsed.request, send)).status, "denied");
  assert.equal(calls, 0);
  const output = await runCli(["gmail", "send", ...base, "--json"], (request) =>
    callGateway({ ...authority, controlToken }, request, send),
  );
  assert.equal(output.exitCode, 7);
  assert.match(output.stdout, /"status":"unknown"/);
  assert.equal(calls, 1);
});
