import assert from "node:assert/strict";
import { test } from "bun:test";
import { parseCommand } from "../src/parse";

const accountId = "11111111-1111-4111-8111-111111111111";
test("RSVP CLI requires an exact event version, scope, response and notification choice", () => {
  const args = [
    "calendar",
    "rsvp",
    "--account",
    accountId,
    "--calendar",
    "owner@example.com",
    "--id",
    "event1",
    "--etag",
    '"before"',
    "--scope",
    '{"kind":"single"}',
    "--key",
    "rsvp",
    "--notify",
    "all",
    "--response",
    "accepted",
  ];
  const parsed = parseCommand(args);
  assert.equal(parsed.kind, "request");
  assert.deepEqual(parsed.request, {
    version: 1,
    command: "calendar.rsvp",
    accountId,
    calendarId: "owner@example.com",
    eventId: "event1",
    etag: '"before"',
    scope: { kind: "single" },
    key: "rsvp",
    sendUpdates: "all",
    response: "accepted",
  });
  for (const extra of [
    ["--changes", '{"summary":"other"}'],
    ["--event", "{}"],
    ["--response", "declined"],
  ])
    assert.throws(() => parseCommand([...args, ...extra]));
  assert.throws(() => parseCommand(args.slice(0, -2)));
  assert.throws(() => parseCommand([...args.slice(0, -1), "confirmed"]));
});
