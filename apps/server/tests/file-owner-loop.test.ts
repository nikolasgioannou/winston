import assert from "node:assert/strict";
import { test } from "bun:test";
import { startOwnerFileLoop } from "../src/files/owner-loop";

test("file workers rotate beyond their capacity and cancel active transfers on shutdown", async () => {
  const owners = ["01", "02", "03", "04"];
  const seen: string[] = [];
  const release = new Map<string, () => void>();
  let active = 0;
  let maximum = 0;
  const runtime = startOwnerFileLoop({
    database: {
      telegramOwners: (_bot: number, cursor?: string) =>
        Promise.resolve(owners.filter((owner) => owner > (cursor ?? ""))),
    },
    botId: 123,
    async run(owner, signal) {
      assert.ok(!release.has(owner));
      seen.push(owner);
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => {
        release.set(owner, resolve);
        signal.addEventListener(
          "abort",
          () => {
            resolve();
          },
          { once: true },
        );
      });
      active -= 1;
      release.delete(owner);
    },
    failed: () => {
      assert.fail("Unexpected worker error");
    },
  });
  async function until(count: number) {
    const deadline = Date.now() + 2500;
    while (seen.length < count && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(seen.length, count);
  }
  try {
    await until(2);
    assert.deepEqual(seen, ["01", "02"]);
    release.get("01")?.();
    release.get("02")?.();
    await until(4);
    assert.deepEqual(seen, owners);
    release.get("03")?.();
    release.get("04")?.();
    await until(6);
    assert.deepEqual(seen, [...owners, "01", "02"]);
    assert.equal(maximum, 2);
  } finally {
    await runtime.stop();
  }
  assert.equal(active, 0);
});
