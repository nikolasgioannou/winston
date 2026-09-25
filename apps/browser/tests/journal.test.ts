import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { Database } from "bun:sqlite";
import { openBrowserJournal } from "../src/journal";
import { openBrowserOwnership } from "../src/ownership";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "winston-browser-journal-"));
  const identity = { ownerId: randomUUID(), browserId: randomUUID() };
  return {
    root,
    identity,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("browser journal survives reopening and the gate requires a fresh ownership grant", async () => {
  const f = fixture();
  let journal = openBrowserJournal({ ...f, initialize: true });
  try {
    const marker = join(journal.profile, "fixture-cookie-marker");
    writeFileSync(marker, "synthetic-session", { mode: 0o600 });
    journal.persist({
      phase: "human",
      epoch: 1,
      holder: randomUUID(),
      expiresAt: Date.now() + 60000,
    });
    const previous = journal.read();
    journal.close();
    journal = openBrowserJournal(f);
    assert.deepEqual(journal.read(), previous);
    const gate = await openBrowserOwnership({
      previous: journal.read(),
      persist: (state) => {
        journal.persist(state);
        return Promise.resolve();
      },
      disconnectViewers: () => Promise.resolve(),
    });
    assert.equal(gate.snapshot().phase, "frozen");
    assert.equal(journal.read().epoch, 2);
    assert.equal(readFileSync(marker, "utf8"), "synthetic-session");
    assert.throws(() => openBrowserJournal({ ...f, initialize: true }));
    assert.throws(
      () => openBrowserJournal({ ...f, identity: { ...f.identity, ownerId: randomUUID() } }),
      /identity/,
    );
    assert.throws(
      () => openBrowserJournal({ ...f, identity: { ...f.identity, browserId: randomUUID() } }),
      /identity/,
    );
    journal.close();
    assert.throws(() => journal.read(), /closed/);
  } finally {
    journal.close();
    f.cleanup();
  }
});

test("consecutive epoch writes reject stale writers and never reset corrupt ownership", () => {
  const f = fixture();
  const first = openBrowserJournal({ ...f, initialize: true });
  const second = openBrowserJournal(f);
  try {
    first.persist({ phase: "frozen", epoch: 1 });
    assert.throws(() => {
      second.persist({ phase: "frozen", epoch: 1 });
    }, /stale/);
    assert.throws(() => {
      second.persist({ phase: "frozen", epoch: 3 });
    }, /stale/);
    assert.equal(second.read().epoch, 1);
    first.close();
    second.close();
    const db = new Database(join(f.root, "control", "ownership.sqlite"));
    db.run("UPDATE ownership SET document='{}'");
    db.close();
    assert.throws(() => openBrowserJournal(f));
  } finally {
    first.close();
    second.close();
    f.cleanup();
  }
});

test("unsafe, detached and symlinked browser storage is refused without following links", () => {
  const f = fixture();
  const journal = openBrowserJournal({ ...f, initialize: true });
  try {
    const filename = join(f.root, "control", "ownership.sqlite");
    chmodSync(filename, 0o644);
    assert.throws(() => journal.read(), /permissions/);
    chmodSync(filename, 0o600);
    const linked = join(f.root, "linked-journal");
    linkSync(filename, linked);
    assert.throws(() => journal.read(), /permissions/);
    rmSync(linked);
    renameSync(journal.profile, join(f.root, "old-profile"));
    symlinkSync(join(f.root, "old-profile"), journal.profile);
    assert.throws(() => {
      journal.persist({ phase: "frozen", epoch: 1 });
    }, /permissions/);
    rmSync(journal.profile);
    mkdirSync(journal.profile, { mode: 0o700 });
    // A new directory at the same pathname cannot impersonate the mounted profile.
    assert.throws(() => journal.read(), /replaced or detached/);
    journal.close();
    rmSync(journal.profile, { recursive: true });
    renameSync(join(f.root, "old-profile"), journal.profile);
    // A dangling auxiliary symlink is still a symlink, not an absent file.
    const destination = join(f.root, "must-not-be-created");
    const wal = filename + "-wal";
    rmSync(wal, { force: true });
    symlinkSync(destination, wal);
    assert.throws(() => openBrowserJournal(f), /permissions/);
    assert.throws(() => readFileSync(destination));
  } finally {
    journal.close();
    f.cleanup();
  }
});
