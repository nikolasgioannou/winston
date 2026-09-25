import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import type { BrowserOwnership } from "@winston/contracts/browser";
import { openBrowserOwnership } from "../src/ownership";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture() {
  let now = 1000;
  let saved: BrowserOwnership = { phase: "frozen", epoch: 0 };
  let failSave = false;
  let disconnected = 0;
  const gate = await openBrowserOwnership({
    previous: saved,
    now: () => now,
    persist: (state) => {
      if (failSave) return Promise.reject(new Error("fixture-storage-error"));
      saved = structuredClone(state);
      return Promise.resolve();
    },
    disconnectViewers: () => {
      disconnected += 1;
      return Promise.resolve();
    },
  });
  const agent = { holder: randomUUID(), expiresAt: 2000 };
  const human = { holder: randomUUID(), expiresAt: 2000 };
  return {
    gate,
    agent,
    human,
    saved: () => saved,
    disconnected: () => disconnected,
    fail: () => {
      failSave = true;
    },
    expire: () => {
      now = 2001;
    },
  };
}

test("takeover joins automation, discards stale observations, and requires explicit return", async () => {
  const f = await fixture();
  const agentState = await f.gate.activateAgent(f.agent);
  const access = { epoch: agentState.epoch, holder: f.agent.holder };
  const entered = deferred<undefined>();
  const finish = deferred<string>();
  const canceled = deferred<undefined>();
  const running = f.gate.runAgent(access, (signal) => {
    signal.addEventListener(
      "abort",
      () => {
        canceled.resolve(undefined);
      },
      { once: true },
    );
    entered.resolve(undefined);
    return finish.promise;
  });
  const dropped = assert.rejects(running, /control is unavailable/);
  await entered.promise;
  const takeover = f.gate.takeOver(access, f.human, new AbortController().signal);
  await canceled.promise;
  assert.equal(f.gate.snapshot().phase, "pending");
  assert.equal(
    f.gate.allowsHuman({ epoch: f.gate.snapshot().epoch, holder: f.human.holder }),
    false,
  );
  let sideEffects = 0;
  await assert.rejects(
    f.gate.runAgent(access, () => {
      sideEffects += 1;
      return Promise.resolve();
    }),
  );
  finish.resolve("sensitive observation must be dropped");
  await dropped;
  const humanState = await takeover;
  const humanAccess = { epoch: humanState.epoch, holder: f.human.holder };
  assert.equal(sideEffects, 0);
  assert.equal(f.gate.allowsHuman(humanAccess), true);
  assert.equal(f.gate.allowsHuman({ ...humanAccess, holder: randomUUID() }), false);
  await assert.rejects(f.gate.runAgent(access, () => Promise.resolve("stale")));
  const returned = await f.gate.returnToAgent(humanAccess, f.agent);
  assert.equal(f.gate.allowsHuman(humanAccess), false);
  assert.equal(
    await f.gate.runAgent({ epoch: returned.epoch, holder: f.agent.holder }, () =>
      Promise.resolve("new snapshot"),
    ),
    "new snapshot",
  );
  assert.ok(f.disconnected() >= 4);
  await f.gate.freeze();
});

test("canceled drain stays frozen and cannot restart while an old operation still runs", async () => {
  const f = await fixture();
  const state = await f.gate.activateAgent(f.agent);
  const access = { epoch: state.epoch, holder: f.agent.holder };
  const entered = deferred<undefined>();
  const finish = deferred<undefined>();
  const stopped = deferred<undefined>();
  const running = f.gate.runAgent(access, (signal) => {
    signal.addEventListener(
      "abort",
      () => {
        stopped.resolve(undefined);
      },
      { once: true },
    );
    entered.resolve(undefined);
    return finish.promise;
  });
  const discarded = assert.rejects(running);
  await entered.promise;
  const controller = new AbortController();
  const pending = f.gate.takeOver(access, f.human, controller.signal);
  const canceled = assert.rejects(pending);
  await stopped.promise;
  controller.abort();
  await canceled;
  assert.equal(f.gate.snapshot().phase, "frozen");
  await assert.rejects(f.gate.activateAgent(f.agent));
  finish.resolve(undefined);
  await discarded;
  await f.gate.activateAgent(f.agent);
  await f.gate.freeze();
});

test("expiry rejects both sides, restart is frozen, and storage failure poisons the gate", async () => {
  const f = await fixture();
  const state = await f.gate.activateAgent(f.agent);
  const human = await f.gate.takeOver(
    { epoch: state.epoch, holder: f.agent.holder },
    f.human,
    new AbortController().signal,
  );
  f.expire();
  assert.equal(f.gate.allowsHuman({ epoch: human.epoch, holder: f.human.holder }), false);
  await assert.rejects(
    f.gate.returnToAgent({ epoch: human.epoch, holder: f.human.holder }, f.agent),
  );
  assert.equal(f.gate.snapshot().phase, "human");
  const restarted = await openBrowserOwnership({
    previous: f.saved(),
    persist: () => Promise.resolve(),
    disconnectViewers: () => Promise.resolve(),
  });
  assert.equal(restarted.snapshot().phase, "frozen");
  assert.ok(restarted.snapshot().epoch > human.epoch);
  assert.equal(restarted.allowsHuman({ epoch: human.epoch, holder: f.human.holder }), false);
  f.fail();
  await assert.rejects(f.gate.freeze(), /control is unavailable/);
  await assert.rejects(f.gate.activateAgent({ holder: f.agent.holder, expiresAt: 3000 }));
  assert.equal(f.gate.allowsHuman({ epoch: human.epoch, holder: f.human.holder }), false);
});

test("lease expiry aborts active work and concurrent automation never starts", async () => {
  const gate = await openBrowserOwnership({
    previous: { phase: "frozen", epoch: 0 },
    persist: () => Promise.resolve(),
    disconnectViewers: () => Promise.resolve(),
  });
  const holder = randomUUID();
  const state = await gate.activateAgent({ holder, expiresAt: Date.now() + 100 });
  const access = { holder, epoch: state.epoch };
  const entered = deferred<undefined>();
  const running = gate.runAgent(
    access,
    (signal) =>
      new Promise<string>((resolve) => {
        entered.resolve(undefined);
        signal.addEventListener(
          "abort",
          () => {
            resolve("must not be returned");
          },
          { once: true },
        );
      }),
  );
  const rejected = assert.rejects(running);
  await entered.promise;
  let extraEffects = 0;
  await assert.rejects(
    gate.runAgent(access, () => {
      extraEffects += 1;
      return Promise.resolve();
    }),
  );
  access.holder = randomUUID();
  await rejected;
  assert.equal(extraEffects, 0);
  await gate.freeze();
});

test("exhausted epochs cannot restore authority", async () => {
  await assert.rejects(
    openBrowserOwnership({
      previous: { phase: "frozen", epoch: Number.MAX_SAFE_INTEGER - 1 },
      persist: () => Promise.resolve(),
      disconnectViewers: () => Promise.resolve(),
    }),
  );
});
