import assert from "node:assert/strict";
import { test } from "bun:test";
import { parseCommand } from "../src/parse";
import { callGateway } from "../src/gateway";
import { runCli } from "../src/run";
import {
  calendarMutationInputFromCli,
  cliCalendarMutationRequestSchema,
} from "@winston/contracts/cli";

const accountId = "11111111-1111-4111-8111-111111111111";
const calendarId = "team@example.com";
const base = [
  "--account",
  accountId,
  "--calendar",
  calendarId,
  "--key",
  "meeting",
  "--notify",
  "all",
];
const event = {
  summary: "Review",
  description: "Exact\nagenda",
  location: "Office",
  timing: {
    kind: "timed",
    start: "2026-11-01T01:30:00-04:00",
    end: "2026-11-01T01:30:00-05:00",
    timezone: "America/New_York",
  },
  attendees: [{ email: "guest@example.com" }],
  recurrence: [],
  transparency: "opaque",
};

test("Calendar CLI preserves typed event, changes, exact version and recurrence scope", () => {
  const create = parseCommand([
    "calendar",
    "create",
    ...base,
    "--event",
    JSON.stringify(event),
    "--json",
  ]);
  assert.equal(create.kind, "request");
  assert.equal(create.json, true);
  assert.deepEqual(create.request, {
    version: 1,
    command: "calendar.create",
    accountId,
    calendarId,
    key: "meeting",
    sendUpdates: "all",
    event,
  });
  assert.deepEqual(
    calendarMutationInputFromCli(cliCalendarMutationRequestSchema.parse(create.request)),
    {
      key: "meeting",
      intent: { kind: "create", accountId, calendarId, sendUpdates: "all", event },
    },
  );
  for (const command of ["update", "delete"] as const) {
    const scope = {
      kind: "instance",
      recurringEventId: "series1",
      originalStartTime: { date: "2026-10-01" },
    };
    const parsed = parseCommand([
      "calendar",
      command,
      ...base,
      "--id",
      "instance1",
      "--etag",
      '"version1"',
      "--scope",
      JSON.stringify(scope),
      ...(command === "update" ? ["--changes", '{"summary":"Changed"}'] : []),
    ]);
    assert.equal(parsed.kind, "request");
    assert.deepEqual(parsed.request, {
      version: 1,
      command: `calendar.${command}`,
      accountId,
      calendarId,
      key: "meeting",
      sendUpdates: "all",
      eventId: "instance1",
      etag: '"version1"',
      scope,
      ...(command === "update" ? { changes: { summary: "Changed" } } : {}),
    });
  }
  const help = parseCommand(["calendar", "create", "--help"]);
  assert.equal(help.kind, "help");
  assert.ok(JSON.stringify(help.content).includes("timing"));
});

test("Calendar CLI rejects omitted review choices, wrong shapes, unsupported fields and duplicate flags", () => {
  for (const args of [
    ["calendar", "create", ...base.slice(0, -2), "--event", JSON.stringify(event)],
    ["calendar", "create", ...base, "--event", "{}"],
    ["calendar", "create", ...base, "--event", "not-json"],
    ["calendar", "create", ...base, "--event", JSON.stringify(event), "--notify", "none"],
    ["calendar", "create", ...base, "--event", JSON.stringify(event), "--query", "injected"],
    ["calendar", "create", ...base, "--event", JSON.stringify({ ...event, calendarId: "other" })],
    [
      "calendar",
      "update",
      ...base,
      "--id",
      "event1",
      "--etag",
      '"v"',
      "--changes",
      '{"summary":"Changed"}',
    ],
    [
      "calendar",
      "update",
      ...base,
      "--id",
      "event1",
      "--etag",
      '"v"',
      "--scope",
      '{"kind":"single"}',
      "--changes",
      "{}",
    ],
    [
      "calendar",
      "delete",
      ...base,
      "--id",
      "event1",
      "--etag",
      "unquoted",
      "--scope",
      '{"kind":"single"}',
    ],
    [
      "calendar",
      "delete",
      ...base,
      "--id",
      "event1",
      "--etag",
      '"v"',
      "--scope",
      '{"kind":"following"}',
    ],
    [
      "calendar",
      "delete",
      ...base,
      "--id",
      "event1",
      "--etag",
      '"v"',
      "--scope",
      '{"kind":"single"}',
      "--changes",
      "{}",
    ],
  ])
    assert.throws(() => parseCommand(args));
});

test("Calendar CLI uses control authority and never retries an uncertain transport", async () => {
  const parsed = parseCommand([
    "calendar",
    "create",
    ...base,
    "--event",
    JSON.stringify(event),
    "--json",
  ]);
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
    calls += 1;
    assert.equal(url, "http://127.0.0.1:3001/api/tasks/cli/control");
    assert.equal(new Headers(init.headers).get("Authorization"), `Bearer ${controlToken}`);
    assert.equal(init.redirect, "error");
    assert.equal(typeof init.body, "string");
    if (typeof init.body !== "string") throw new Error("Expected JSON request body.");
    assert.deepEqual(JSON.parse(init.body), parsed.request);
    return Promise.reject(new Error("Uncertain transport"));
  };
  assert.equal((await callGateway(authority, parsed.request, send)).status, "denied");
  assert.equal(calls, 0);
  const output = await runCli(
    ["calendar", "create", ...base, "--event", JSON.stringify(event), "--json"],
    (request) => callGateway({ ...authority, controlToken }, request, send),
  );
  assert.equal(output.exitCode, 7);
  assert.equal(calls, 1);
  assert.ok(output.stdout.includes('"status":"unknown"'));
});
