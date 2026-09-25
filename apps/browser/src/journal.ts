import { Database } from "bun:sqlite";
import {
  browserIdentitySchema,
  browserOwnershipSchema,
  type BrowserIdentity,
  type BrowserOwnership,
} from "@winston/contracts/browser";
import { openBrowserVolume } from "./volume";

type Stored = { epoch: number; document: string };

export function openBrowserJournal(options: {
  root: string;
  identity: BrowserIdentity;
  initialize?: boolean;
  profileUid?: number;
}) {
  const identity = browserIdentitySchema.parse(options.identity);
  const initialize = options.initialize ?? false;
  const profileUid = options.profileUid ?? process.getuid?.();
  if (profileUid === undefined) throw new Error("Browser storage requires Unix ownership.");
  const volume = openBrowserVolume(options.root, initialize, profileUid);
  const database = new Database(volume.filename, { create: false, strict: true });
  let closed = false;
  try {
    database.run("PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    if (initialize) {
      database
        .transaction(() => {
          database.run(`CREATE TABLE identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, document TEXT NOT NULL);
          CREATE TABLE ownership (singleton INTEGER PRIMARY KEY CHECK(singleton=1), epoch INTEGER NOT NULL, document TEXT NOT NULL);`);
          database.query("INSERT INTO identity VALUES(1,1,?)").run(JSON.stringify(identity));
          database
            .query("INSERT INTO ownership VALUES(1,0,?)")
            .run(JSON.stringify({ phase: "frozen", epoch: 0 }));
        })
        .immediate();
    }
    const row = database
      .query<{ version: number; document: string }, []>(
        "SELECT version,document FROM identity WHERE singleton=1",
      )
      .get();
    if (!row || row.version !== 1 || row.document !== JSON.stringify(identity))
      throw new Error("Browser identity or journal version does not match.");
  } catch (error) {
    database.close();
    throw error;
  }
  function assertOpen() {
    if (closed) throw new Error("Browser journal is closed.");
    volume.assertPresent();
  }
  function read() {
    assertOpen();
    const row = database
      .query<Stored, []>("SELECT epoch,document FROM ownership WHERE singleton=1")
      .get();
    if (!row) throw new Error("Browser ownership is unavailable.");
    const state = browserOwnershipSchema.parse(JSON.parse(row.document) as unknown);
    if (state.epoch !== row.epoch) throw new Error("Browser ownership is inconsistent.");
    return state;
  }
  try {
    read();
  } catch (error) {
    database.close();
    throw error;
  }
  return {
    profile: volume.profile,
    read,
    persist(input: BrowserOwnership) {
      assertOpen();
      const next = browserOwnershipSchema.parse(input);
      database
        .transaction(() => {
          const previous = read();
          if (next.epoch !== previous.epoch + 1)
            throw new Error("Browser ownership epoch is stale.");
          const result = database
            .query("UPDATE ownership SET epoch=?,document=? WHERE singleton=1 AND epoch=?")
            .run(next.epoch, JSON.stringify(next), previous.epoch);
          if (result.changes !== 1) throw new Error("Browser ownership epoch is stale.");
        })
        .immediate();
    },
    close() {
      if (!closed) {
        closed = true;
        database.close();
      }
    },
  };
}
