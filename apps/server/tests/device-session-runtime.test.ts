import assert from "node:assert/strict";
import { test } from "bun:test";
import { startDeviceSessionRuntime } from "../src/devices/session-runtime";

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(predicate());
}

test("session recovery pages fairly, retries enumeration and isolates owner failures", async () => {
  const owners = Array.from({ length: 102 }, (_, index) => String(index).padStart(3, "0"));
  const seen: string[] = [];
  const cursors: (string | undefined)[] = [];
  const notices: string[] = [];
  const runtime = startDeviceSessionRuntime({
    intervalMs: 10,
    owners(cursor) {
      cursors.push(cursor);
      if (cursors.length === 2) return Promise.reject(new Error("private database error"));
      return Promise.resolve(owners.filter((owner) => owner > (cursor ?? "")).slice(0, 100));
    },
    expire(owner) {
      seen.push(owner);
      return owner === "001" ? Promise.reject(new Error("private owner error")) : Promise.resolve();
    },
    notice(code) {
      notices.push(code);
    },
  });
  try {
    await until(() => seen.length >= 103);
    assert.deepEqual(seen.slice(0, 103), [...owners, "000"]);
    assert.deepEqual(cursors.slice(0, 4), [undefined, "099", "099", undefined]);
    assert.ok(notices.includes("device-session-expiration-failed"));
    assert.ok(notices.includes("device-session-enumeration-failed"));
    assert.ok(notices.every((notice) => !notice.includes("private")));
  } finally {
    await runtime.stop();
  }
});

test("session recovery never overlaps and shutdown drains only its active transaction", async () => {
  let release = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let enumerations = 0;
  const seen: string[] = [];
  const runtime = startDeviceSessionRuntime({
    intervalMs: 10,
    owners() {
      enumerations += 1;
      return Promise.resolve(["first", "second"]);
    },
    expire(owner) {
      seen.push(owner);
      return blocked;
    },
    notice() {
      assert.fail("Unexpected recovery error");
    },
  });
  try {
    await until(() => seen.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(enumerations, 1);
    let stopped = false;
    const stopping = runtime.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    assert.equal(stopped, false);
    release();
    await stopping;
    assert.deepEqual(seen, ["first"]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(enumerations, 1);
  } finally {
    release();
    await runtime.stop();
  }
});
