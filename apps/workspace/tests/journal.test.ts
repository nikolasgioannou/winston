import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { WorkspaceOperation } from "@winston/contracts/workspace";
import { openWorkspaceJournal } from "../src/journal";

const roots: string[] = [];
const journals: ReturnType<typeof openWorkspaceJournal>[] = [];
const identity = { ownerId: randomUUID(), workspaceId: randomUUID() };

function request(): WorkspaceOperation {
  return {
    version: 1,
    identity,
    operationId: randomUUID(),
    taskId: randomUUID(),
    revision: 2,
    generation: 3,
    kind: "command:execute",
    inputHash: "a".repeat(64),
  };
}

function open(root: string, initialize = false) {
  const journal = openWorkspaceJournal({ root, identity, initialize });
  journals.push(journal);
  return journal;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "winston-workspace-"));
  roots.push(root);
  return { root, journal: open(root, true) };
}

afterEach(() => {
  for (const journal of journals.splice(0)) journal.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("completed outcomes and home files survive reopening without replay", () => {
  const { root, journal } = fixture();
  const operation = request();
  const started = journal.start(operation);
  if (!started.started) throw new Error("Expected a new operation.");
  writeFileSync(join(journal.home, "work.txt"), "persistent work");
  expect(
    journal.finish(operation, started.completionToken, { state: "completed", result: "done" }),
  ).toBe(true);
  journal.close();

  const reopened = open(root);
  expect(readFileSync(join(reopened.home, "work.txt"), "utf8")).toBe("persistent work");
  expect(reopened.start(operation)).toEqual({
    started: false,
    record: {
      request: operation,
      state: "completed",
      outcome: { state: "completed", result: "done" },
    },
  });
});

test("two journal handles cannot start the same operation twice", () => {
  const { root, journal } = fixture();
  const second = open(root);
  const operation = request();
  expect(journal.start(operation).started).toBe(true);
  expect(second.start(operation)).toMatchObject({ started: false, record: { state: "running" } });
});

test("changed arguments or task authority cannot reuse an operation ID", () => {
  const { journal } = fixture();
  const operation = request();
  journal.start(operation);
  for (const change of [
    { inputHash: "b".repeat(64) },
    { taskId: randomUUID() },
    { revision: 3 },
    { generation: 4 },
    { kind: "file:write" as const },
  ]) {
    expect(() => journal.start({ ...operation, ...change })).toThrow("reused");
    expect(() => journal.read({ ...operation, ...change })).toThrow("does not match");
  }
});

test("volume identity and operation owner cannot be substituted", () => {
  const { root, journal } = fixture();
  expect(() =>
    openWorkspaceJournal({ root, identity: { ...identity, ownerId: randomUUID() } }),
  ).toThrow("identity");
  expect(() =>
    journal.start({ ...request(), identity: { ...identity, workspaceId: randomUUID() } }),
  ).toThrow("another workspace");
});

test("interrupted operations become unknown and reject stale completion", () => {
  const { root, journal } = fixture();
  const operation = request();
  const started = journal.start(operation);
  if (!started.started) throw new Error("Expected a new operation.");
  journal.close();
  const reopened = open(root);
  expect(reopened.recoverInterrupted()).toBe(1);
  expect(reopened.recoverInterrupted()).toBe(0);
  expect(
    reopened.finish(operation, started.completionToken, { state: "completed", result: "late" }),
  ).toBe(false);
  expect(reopened.start(operation)).toMatchObject({
    started: false,
    record: { state: "unknown", outcome: null },
  });
});

test("completion requires the original token and cannot overwrite a terminal result", () => {
  const { journal } = fixture();
  const operation = request();
  const started = journal.start(operation);
  if (!started.started) throw new Error("Expected a new operation.");
  expect(journal.finish(operation, randomUUID(), { state: "completed", result: "forged" })).toBe(
    false,
  );
  expect(
    journal.finish(operation, started.completionToken, {
      state: "failed",
      code: "execution_failed",
    }),
  ).toBe(true);
  expect(
    journal.finish(operation, started.completionToken, { state: "completed", result: "changed" }),
  ).toBe(false);
  expect(journal.read(operation)?.outcome).toEqual({ state: "failed", code: "execution_failed" });
});

test("a killed process leaves a durable uncertain operation instead of a fresh retry", async () => {
  const { root, journal } = fixture();
  journal.close();
  const operation = request();
  const child = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(new URL("./fixtures/crash.ts", import.meta.url)),
      root,
      JSON.stringify(operation),
    ],
    {
      cwd: root,
      env: {},
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(await new Response(child.stdout).text()).toBe("started\n");
  expect(await child.exited).not.toBe(0);
  const reopened = open(root);
  expect(reopened.read(operation)?.state).toBe("running");
  expect(reopened.recoverInterrupted()).toBe(1);
  expect(reopened.start(operation)).toMatchObject({ started: false, record: { state: "unknown" } });
});

test("ordinary startup never silently initializes absent storage", () => {
  const root = mkdtempSync(join(tmpdir(), "winston-empty-workspace-"));
  roots.push(root);
  expect(() => open(root)).toThrow();
  expect(() => open(join(root, "missing"), true)).toThrow();
  const journal = open(root, true);
  expect(() => open(root, true)).toThrow();
  expect(journal.start(request()).started).toBe(true);
});

test("replaced home and symlinked control paths fail closed", () => {
  const { root, journal } = fixture();
  renameSync(journal.home, join(root, "old-home"));
  symlinkSync(join(root, "old-home"), journal.home);
  expect(() => journal.start(request())).toThrow("directory");
  journal.close();
  renameSync(join(root, "control"), join(root, "old-control"));
  symlinkSync(join(root, "old-control"), join(root, "control"));
  expect(() => open(root)).toThrow("directory");
});
