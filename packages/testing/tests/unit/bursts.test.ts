import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { serializeMessageBurst } from "@winston/contracts/bursts";

test("burst annotations reference original messages without synthesizing owner prose", () => {
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  const xml = serializeMessageBurst({ revision: 3, messageIds: ids });
  assert.match(xml, /^<system_event kind="message_burst" revision="3">/);
  for (const id of ids) assert.ok(xml.includes(`<message id="${id}"></message>`));
  assert.throws(() => serializeMessageBurst({ revision: 3, messageIds: ["<instruction>"] }));
});
