import assert from "node:assert/strict";
import { test } from "bun:test";
import { cliExitCodes, type CliResult } from "@winston/contracts/cli";
import { parseCommand } from "../src/parse";
import { runCli } from "../src/run";

const id = "5f445ff8-9955-455a-8632-bff6fe58c745";

test("draft reads keep explicit account, draft identity and distinct pagination cursors", () => {
  const cursor = { kind: "drafts", connectionId: id, query: "subject:Plan", pageToken: "next" };
  assert.deepEqual(
    parseCommand([
      "gmail",
      "drafts",
      "--account",
      id,
      "--query",
      "subject:Plan",
      "--cursor",
      JSON.stringify(cursor),
      "--key",
      "draft-list",
    ]),
    {
      kind: "request",
      json: false,
      request: {
        version: 1,
        command: "gmail.drafts",
        accountId: id,
        query: "subject:Plan",
        limit: 25,
        cursor,
        key: "draft-list",
      },
    },
  );
  assert.deepEqual(
    parseCommand(["gmail", "draft", "--account", id, "--id", "draft1", "--key", "draft-read"]),
    {
      kind: "request",
      json: false,
      request: {
        version: 1,
        command: "gmail.draft",
        accountId: id,
        id: "draft1",
        key: "draft-read",
      },
    },
  );
  for (const args of [
    ["gmail", "draft", "--id", "draft1"],
    ["gmail", "draft", "--account", id, "--id", "draft1", "--query", "ignored"],
    ["gmail", "search", "--account", id, "--cursor", JSON.stringify(cursor)],
    [
      "gmail",
      "drafts",
      "--account",
      id,
      "--cursor",
      JSON.stringify({ connectionId: id, query: "", pageToken: "next" }),
    ],
  ])
    assert.throws(() => parseCommand(args));
});

test("responsibility commands accept explicit scope and paired agreement references only", () => {
  const scope = [
    { target: { kind: "workspace", id, resource: null }, operation: "workspace.command" },
  ];
  const parsed = parseCommand([
    "responsibilities",
    "propose",
    "--key",
    "watch",
    "--purpose",
    "Watch changes",
    "--scope",
    JSON.stringify(scope),
  ]);
  assert.deepEqual(parsed, {
    kind: "request",
    json: false,
    request: {
      version: 1,
      command: "responsibilities.propose",
      key: "watch",
      purpose: "Watch changes",
      scope,
    },
  });
  const schedule = [
    "schedules",
    "create",
    "--key",
    "daily",
    "--objective",
    "Check changes",
    "--at",
    "2030-01-01T12:00:00.000Z",
  ];
  const bound = parseCommand([...schedule, "--responsibility", id, "--agreement-revision", "0"]);
  assert.equal(bound.kind, "request");
  assert.equal(bound.request.command, "schedules.create");
  assert.deepEqual(bound.request.responsibility, { id, agreementRevision: 0 });
  for (const args of [
    [...schedule, "--responsibility", id],
    [...schedule, "--agreement-revision", "0"],
    [...schedule, "--responsibility", id, "--agreement-revision", "NaN"],
    ["responsibilities", "agree", "--id", id],
    ["responsibilities", "propose", "--key", "x", "--purpose", "x", "--scope", "{}"],
    ["responsibilities", "inspect", "--id", id, "--scope", "[]"],
  ])
    assert.throws(() => parseCommand(args));
});

test("schedule commands require explicit timing and revision-checked edits", () => {
  assert.deepEqual(
    parseCommand([
      "schedules",
      "create",
      "--key",
      "plants",
      "--objective",
      "Water plants",
      "--at",
      "2030-01-01T14:00:00.000Z",
    ]),
    {
      kind: "request",
      json: false,
      request: {
        version: 1,
        command: "schedules.create",
        key: "plants",
        objective: "Water plants",
        startAt: "2030-01-01T14:00:00.000Z",
      },
    },
  );
  assert.deepEqual(parseCommand(["schedules", "cancel", "--id", id, "--revision", "2"]), {
    kind: "request",
    json: false,
    request: { version: 1, command: "schedules.cancel", id, revision: 2 },
  });
  assert.throws(() => parseCommand(["schedules", "cancel", "--id", id]));
  assert.throws(() => parseCommand(["schedules", "list", "--rule", "FREQ=DAILY"]));
  assert.throws(() =>
    parseCommand([
      "schedules",
      "create",
      "--key",
      "plants",
      "--objective",
      "Water plants",
      "--at",
      "tomorrow",
    ]),
  );
});

test("pause and resume require the current schedule revision", () => {
  for (const action of ["pause", "resume"] as const) {
    assert.deepEqual(parseCommand(["schedules", action, "--id", id, "--revision", "2"]), {
      kind: "request",
      json: false,
      request: { version: 1, command: `schedules.${action}`, id, revision: 2 },
    });
    assert.throws(() => parseCommand(["schedules", action, "--id", id]));
  }
});

test("file delivery commands require explicit artifact and stable request identities", () => {
  assert.deepEqual(parseCommand(["files", "send", "--id", id, "--key", "report"]), {
    kind: "request",
    json: false,
    request: { version: 1, command: "files.send", id, key: "report" },
  });
  assert.deepEqual(parseCommand(["files", "status", "--id", id]), {
    kind: "request",
    json: false,
    request: { version: 1, command: "files.status", id },
  });
  assert.throws(() => parseCommand(["files", "send", "--id", id]));
  assert.throws(() =>
    parseCommand(["files", "send", "--id", id, "--key", "report", "--account", id]),
  );
});

test("file inspection accepts only an explicit path", () => {
  assert.deepEqual(
    parseCommand(["files", "inspect", "--path", "/data/home/artifacts/report.pdf", "--json"]),
    {
      kind: "request",
      json: true,
      request: { version: 1, command: "files.inspect", path: "/data/home/artifacts/report.pdf" },
    },
  );
  assert.throws(() => parseCommand(["files", "inspect"]));
  assert.throws(() =>
    parseCommand([
      "files",
      "inspect",
      "--path",
      "/data/home/artifacts/report.pdf",
      "--account",
      id,
    ]),
  );
});
test("connected reads require explicit targets and reject unrelated or malformed flags", () => {
  const gmail = parseCommand([
    "gmail",
    "search",
    "--account",
    id,
    "--query",
    "from:fixture",
    "--limit",
    "2",
  ]);
  assert.equal(gmail.kind, "request");
  assert.deepEqual(gmail.request, {
    version: 1,
    command: "gmail.search",
    accountId: id,
    query: "from:fixture",
    limit: 2,
  });
  const calendar = parseCommand([
    "calendar",
    "events",
    "--account",
    id,
    "--calendar",
    "team@example.com",
    "--from",
    "2026-11-01T00:00:00-04:00",
    "--until",
    "2026-11-02T00:00:00-05:00",
    "--timezone",
    "America/New_York",
  ]);
  assert.equal(calendar.kind, "request");
  assert.equal(calendar.request.command, "calendar.events");
  assert.equal(calendar.request.calendarId, "team@example.com");
  const availabilityArgs = [
    "calendar",
    "availability",
    "--account",
    id,
    "--calendar",
    "team@example.com",
    "--from",
    "2026-11-01T00:00:00-04:00",
    "--until",
    "2026-11-02T00:00:00-05:00",
    "--timezone",
    "America/New_York",
  ];
  const availability = parseCommand(availabilityArgs);
  assert.equal(availability.kind, "request");
  assert.equal(availability.request.command, "calendar.availability");
  assert.equal("query" in availability.request.window, false);
  assert.throws(() => parseCommand([...availabilityArgs, "--query", "ignored"]));
  for (const args of [
    ["gmail", "search"],
    ["gmail", "search", "--account", id, "--limit", "NaN"],
    ["gmail", "message", "--account", id, "--id", "msg", "--query", "ignored"],
    ["accounts", "list", "--account", id],
    ["calendar", "events", "--account", id, "--calendar", "team"],
    ["gmail", "search", "--account", id, "--cursor", "bad-json"],
    ["help", "calendar", "--account", id],
  ])
    assert.throws(() => parseCommand(args));
});

test("help and malformed arguments never call the gateway", async () => {
  let calls = 0;
  const execute = (): Promise<CliResult> => {
    calls += 1;
    return Promise.resolve({ version: 1, status: "ok", data: null });
  };
  for (const args of [
    [],
    ["--help"],
    ["help", "devices"],
    ["devices", "inspect", "-h", "--json"],
  ]) {
    const result = await runCli(args, execute);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /devices inspect/);
  }
  for (const args of [
    ["devices"],
    ["missing", "list"],
    ["accounts", "list", "extra"],
    ["devices", "inspect"],
    ["devices", "inspect", "--id", "bad"],
    ["devices", "inspect", "--id", id, "--id", id],
    ["accounts", "list", "--id", id],
    ["accounts", "list", "--token", "secret"],
    ["--help", "--help"],
    ["devices", "inspect", "--id"],
    ["help", "missing"],
    ["accounts", "list", "--json=true"],
  ]) {
    const result = await runCli(args, execute);
    assert.equal(result.exitCode, 2, JSON.stringify(args));
    assert.doesNotMatch(result.stderr, /secret/);
  }
  assert.equal(calls, 0);
});

test("command routing produces validated versioned requests", () => {
  assert.deepEqual(
    parseCommand([
      "accounts",
      "connect",
      "--service",
      "gmail",
      "--key",
      "itinerary",
      "--detail",
      "Find the itinerary",
      "--id",
      id,
    ]),
    {
      kind: "request",
      json: false,
      request: {
        version: 1,
        command: "accounts.connect",
        service: "gmail",
        key: "itinerary",
        detail: "Find the itinerary",
        id,
      },
    },
  );
  for (const args of [
    ["accounts", "connect"],
    ["accounts", "connect", "--service", "unknown", "--key", "x", "--detail", "x"],
    ["accounts", "list", "--service", "gmail"],
    ["help", "accounts", "--key", "x"],
  ])
    assert.throws(() => parseCommand(args));
  for (const command of ["devices.inspect", "operations.inspect", "operations.cancel"]) {
    assert.deepEqual(parseCommand([...command.split("."), "--id", id, "--json"]), {
      kind: "request",
      json: true,
      request: { version: 1, command, id },
    });
  }
  assert.deepEqual(parseCommand(["accounts", "list"]), {
    kind: "request",
    json: false,
    request: { version: 1, command: "accounts.list" },
  });
});

test("results preserve machine-readable states and never retry uncertain operations", async () => {
  for (const status of [
    "denied",
    "approval_required",
    "waiting",
    "unavailable",
    "unknown",
  ] as const) {
    const response: CliResult = {
      version: 1,
      status,
      message: "Check the operation",
      referenceId: id,
    };
    const result = await runCli(["operations", "cancel", "--id", id, "--json"], () =>
      Promise.resolve(response),
    );
    assert.equal(result.exitCode, cliExitCodes[status]);
    assert.deepEqual(JSON.parse(result.stdout), response);
    assert.equal(result.stderr, "");
  }
  let calls = 0;
  const unknown = await runCli(["operations", "cancel", "--id", id], () => {
    calls += 1;
    return Promise.reject(new Error("secret credential"));
  });
  assert.equal(calls, 1);
  assert.equal(unknown.exitCode, 7);
  assert.doesNotMatch(unknown.stderr, /secret/);
  const readable = await runCli(["devices", "list"], () =>
    Promise.resolve({
      version: 1,
      status: "waiting",
      message: "Device\u001b[31m unavailable",
    }),
  );
  assert.equal(readable.stderr.includes(String.fromCharCode(27)), false);
});
