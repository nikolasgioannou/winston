import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "bun:test";
import type { CommandResult } from "@winston/contracts/commands";
import { canonicalJson } from "@winston/contracts/json";
import type { WorkspaceCommand } from "@winston/contracts/workspace-commands";
import { createCommandService } from "../src/commands";
import { createCommandHandler } from "../src/command-http";
import { openWorkspaceJournal } from "../src/journal";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function clock() {
  let now = 0;
  const timers = new Set<{ at: number; callback: () => void }>();
  return {
    after(ms: number, callback: () => void) {
      const timer = { at: now + ms, callback };
      timers.add(timer);
      return () => {
        timers.delete(timer);
      };
    },
    async advance(ms: number) {
      now += ms;
      for (const timer of [...timers].sort((a, b) => a.at - b.at)) {
        if (timer.at <= now && timers.delete(timer)) timer.callback();
      }
      // Drain authorization and completion continuations without using wall-clock sleeps.
      for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
    },
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "winston-commands-"));
  const identity = { ownerId: randomUUID(), workspaceId: randomUUID() };
  const journal = openWorkspaceJournal({ root, identity, initialize: true });
  const time = clock();
  let starts = 0;
  let cancellations = 0;
  let allowed = true;
  let outage = false;
  const output = {
    bytes: 0,
    sha256: createHash("sha256").update("").digest("hex"),
    preview: "",
    truncated: false,
  };
  const result: CommandResult = {
    exitCode: 0,
    signal: null,
    reason: "exited",
    durationMs: 1,
    stdout: output,
    stderr: output,
  };
  const pending: ReturnType<typeof Promise.withResolvers<CommandResult>>[] = [];
  const runner = {
    output() {
      return new Blob([]).stream();
    },
    start() {
      starts += 1;
      const next = Promise.withResolvers<CommandResult>();
      pending.push(next);
      return {
        result: next.promise,
        cancel() {
          cancellations += 1;
          next.resolve({ ...result, reason: "canceled" });
        },
      };
    },
    close() {
      for (const next of pending) next.resolve({ ...result, reason: "canceled" });
      return Promise.resolve();
    },
  };
  const service = createCommandService({
    journal,
    runner,
    after: (ms, callback) => time.after(ms, callback),
    authority: {
      command(credential) {
        if (outage) return Promise.reject(new Error("Private authority detail"));
        return Promise.resolve(allowed && credential.operation === "workspace:execute");
      },
      control(credential) {
        return Promise.resolve(
          credential.operation === "workspace:observe" ||
            credential.operation === "workspace:cancel",
        );
      },
    },
  });
  cleanup.push(async () => {
    await service.close();
    journal.close();
    rmSync(root, { recursive: true, force: true });
  });
  const input = {
    argv: ["echo", "fixture"],
    cwd: journal.home,
    env: {},
    timeoutMs: 60_000,
    maxOutputBytes: 1024,
  };
  const command: WorkspaceCommand = {
    operation: {
      version: 1,
      identity,
      operationId: randomUUID(),
      taskId: randomUUID(),
      revision: 1,
      generation: 1,
      kind: "command:execute",
      inputHash: createHash("sha256").update(canonicalJson(input)).digest("hex"),
    },
    input,
    dispatch: { id: randomUUID(), token: `wda_${"d".repeat(43)}` },
  };
  const credential = {
    token: `wst_${"a".repeat(43)}`,
    kind: "worker" as const,
    subjectId: randomUUID(),
    resourceId: identity.workspaceId,
    operation: "workspace:execute" as const,
  };
  return {
    service,
    journal,
    time,
    command,
    credential,
    result,
    handler: createCommandHandler(identity, service),
    starts: () => starts,
    cancellations: () => cancellations,
    allow(value: boolean) {
      allowed = value;
    },
    outage() {
      outage = true;
    },
    complete(value = result) {
      pending[0]?.resolve(value);
    },
  };
}

test("commands start asynchronously, deduplicate retries, and persist exact outcomes", async () => {
  const f = fixture();
  const starts = await Promise.all([
    f.service.start(f.credential, f.command),
    f.service.start(f.credential, f.command),
  ]);
  expect(starts.map((record) => record?.state)).toEqual(["running", "running"]);
  expect(f.starts()).toBe(1);
  f.complete();
  await f.time.advance(0);
  const record = await f.service.start(f.credential, f.command);
  expect(record?.state).toBe("completed");
  expect(record?.outcome).toEqual({ state: "completed", result: JSON.stringify(f.result) });
  expect(f.starts()).toBe(1);
  await f.time.advance(60_000);
  expect(f.cancellations()).toBe(0);
});

test("renewal extends only an active exact execution and expiry stops its process", async () => {
  const f = fixture();
  await f.service.start(f.credential, f.command);
  await f.time.advance(20_000);
  await f.service.renew(f.credential, f.command);
  await f.time.advance(10_000);
  expect(f.cancellations()).toBe(0);
  await f.time.advance(20_000);
  expect(f.cancellations()).toBe(1);
  expect(f.journal.read(f.command.operation)?.state).toBe("completed");
  await f.service.renew(f.credential, f.command);
  await f.service.start(f.credential, f.command);
  expect(f.starts()).toBe(1);
});

test("revocation and authority outages stop commands without blocking scoped recovery", async () => {
  for (const outage of [false, true]) {
    const f = fixture();
    await f.service.start(f.credential, f.command);
    if (outage) f.outage();
    else f.allow(false);
    await f.time.advance(5000);
    expect(f.cancellations()).toBe(1);
    const record = await f.service.control(
      { ...f.credential, operation: "workspace:observe" },
      f.command.operation,
    );
    expect(record?.state).toBe("completed");
    await assert.rejects(f.service.renew(f.credential, f.command));
  }
});

test("cancel is operation scoped and interrupted or uncertain operations never restart", async () => {
  const f = fixture();
  await f.service.start(f.credential, f.command);
  await assert.rejects(
    f.service.control(
      { ...f.credential, operation: "workspace:cancel" },
      { ...f.command.operation, inputHash: "b".repeat(64) },
    ),
  );
  expect(f.cancellations()).toBe(0);
  await f.service.control({ ...f.credential, operation: "workspace:cancel" }, f.command.operation);
  await f.time.advance(0);
  expect(f.cancellations()).toBe(1);
  const interrupted = fixture();
  interrupted.journal.start(interrupted.command.operation);
  interrupted.journal.recoverInterrupted();
  expect(
    (await interrupted.service.start(interrupted.credential, interrupted.command))?.state,
  ).toBe("unknown");
  expect(interrupted.starts()).toBe(0);
  const uncertain = fixture();
  await uncertain.service.start(uncertain.credential, uncertain.command);
  uncertain.complete({ ...uncertain.result, reason: "unknown" });
  await uncertain.time.advance(0);
  expect((await uncertain.service.start(uncertain.credential, uncertain.command))?.state).toBe(
    "unknown",
  );
  expect(uncertain.starts()).toBe(1);
});

test("runtime HTTP rejects tampering, foreign owners and wrong scopes without exposing errors", async () => {
  const f = fixture();
  const send = (mode: string, body: unknown = f.command, token = f.credential.token) =>
    f.handler(
      new Request(`http://localhost/v1/commands/${mode}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "X-Winston-Worker": f.credential.subjectId },
        body: JSON.stringify(body),
      }),
    );
  expect((await send("start", f.command, "invalid"))?.status).toBe(401);
  expect((await send("start", {}))?.status).toBe(400);
  expect(
    (await send("start", { ...f.command, input: { ...f.command.input, argv: ["changed"] } }))
      ?.status,
  ).toBe(403);
  expect(
    (
      await send("start", {
        ...f.command,
        operation: {
          ...f.command.operation,
          identity: { ...f.command.operation.identity, ownerId: randomUUID() },
        },
      })
    )?.status,
  ).toBe(403);
  expect(f.starts()).toBe(0);
  const started = await send("start");
  expect(started?.status).toBe(200);
  expect(started?.headers.get("Cache-Control")).toBe("no-store");
  expect((await send("status", f.command.operation))?.status).toBe(200);
  f.outage();
  const response = await send("renew");
  expect(response?.status).toBe(503);
  expect(await response?.text()).not.toContain("Private");
  expect((await send("cancel", f.command.operation))?.status).toBe(200);
  await f.time.advance(0);
  await f.service.close();
  expect(f.cancellations()).toBe(1);
});
