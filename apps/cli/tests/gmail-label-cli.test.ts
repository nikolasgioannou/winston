import assert from "node:assert/strict";
import { test } from "bun:test";
import { parseCommand } from "../src/parse";
import { callGateway } from "../src/gateway";

const accountId = "11111111-1111-4111-8111-111111111111";
const args = ["gmail", "modify", "--account", accountId, "--id", "m1", "--key", "organize"];
test("Gmail label changes require exact IDs and the control route", async () => {
  const parsed = parseCommand([
    ...args,
    "--add-labels",
    '["STARRED"]',
    "--remove-labels",
    '["UNREAD"]',
  ]);
  assert.equal(parsed.kind, "request");
  assert.deepEqual(parsed.request, {
    version: 1,
    command: "gmail.modify",
    accountId,
    messageId: "m1",
    key: "organize",
    addLabelIds: ["STARRED"],
    removeLabelIds: ["UNREAD"],
  });
  for (const extra of [
    [],
    ["--add-labels", "{}"],
    ["--add-labels", '["TRASH"]'],
    ["--remove-labels", '["DRAFT"]'],
    ["--add-labels", '["STARRED"]', "--remove-labels", '["STARRED"]'],
    ["--add-labels", '["STARRED"]', "--query", "anything"],
  ])
    assert.throws(() => parseCommand([...args, ...extra]));
  let calls = 0;
  const authority = {
    version: 1 as const,
    environment: "local" as const,
    workspaceId: accountId,
    token: `wst_${"r".repeat(43)}`,
    controlToken: `wst_${"c".repeat(43)}`,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const result = await callGateway(authority, parsed.request, (url, init) => {
    calls++;
    assert.equal(new URL(url).pathname, "/api/tasks/cli/control");
    assert.equal(
      new Headers(init.headers).get("Authorization"),
      `Bearer ${authority.controlToken}`,
    );
    return Promise.resolve(Response.json({ version: 1, status: "unknown", message: "Reply lost" }));
  });
  assert.equal(result.status, "unknown");
  assert.equal(calls, 1);
  assert.equal(
    (await callGateway({ ...authority, controlToken: undefined }, parsed.request)).status,
    "denied",
  );
});
