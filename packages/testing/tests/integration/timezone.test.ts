import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { timestampSnapshot, validTimezone } from "@winston/contracts/timezone";
import { withTestPostgres } from "../../src/postgres";

test("timezone profiles default to UTC and serialize competing observations without changing history", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const ownerId = randomUUID();
    const secondOwnerId = randomUUID();

    try {
      for (const id of [ownerId, secondOwnerId]) {
        await database.transaction(id, (scope) => scope.owners.ensure());
      }

      const initial = await database.transaction(ownerId, (scope) => scope.owners.timezone());
      assert.deepEqual(initial, {
        timezone: "UTC",
        revision: 0,
        observedAt: null,
        source: "default",
      });
      const [first, second] = await Promise.all([
        database.transaction(ownerId, (scope) =>
          scope.owners.updateTimezone("America/New_York", 0),
        ),
        database.transaction(ownerId, (scope) =>
          scope.owners.updateTimezone("America/Los_Angeles", 0),
        ),
      ]);
      assert.equal(Number(first.conflict) + Number(second.conflict), 1);
      const current = await database.transaction(ownerId, (scope) => scope.owners.timezone());
      assert.equal(current.revision, 1);
      assert.ok(current.observedAt);
      const duplicate = await database.transaction(ownerId, (scope) =>
        scope.owners.updateTimezone(current.timezone, 0),
      );
      assert.deepEqual(duplicate.profile, current);

      for (const invalid of [undefined, "", "Made/Up", "+05:00"]) {
        const ignored = await database.transaction(ownerId, (scope) =>
          scope.owners.updateTimezone(invalid, 1),
        );
        assert.deepEqual(ignored.profile, current);
      }

      const past = timestampSnapshot(new Date("2026-01-01T12:00:00Z"), current.timezone);
      await sql`CREATE TABLE history_fixture (snapshot jsonb, scheduled_at timestamptz)`;
      await sql`INSERT INTO history_fixture VALUES (jsonb_build_object('instant', ${past.instant}::text, 'timezone', ${past.timezone}::text, 'offset', ${past.offset}::text), '2026-12-01T12:00:00Z')`;
      const changed = await database.transaction(ownerId, (scope) =>
        scope.owners.updateTimezone("Asia/Kolkata", current.revision),
      );
      assert.equal(changed.profile.revision, 2);
      const [history] = await sql<
        { snapshot: typeof past; instant: string }[]
      >`SELECT snapshot, to_char(scheduled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS instant FROM history_fixture`;
      assert.deepEqual(history?.snapshot, past);
      assert.equal(history.instant, "2026-12-01T12:00:00Z");
      assert.deepEqual(
        await database.transaction(secondOwnerId, (scope) => scope.owners.timezone()),
        initial,
      );
    } finally {
      await database.close();
    }
  });
});

test("timestamp snapshots use the offset at the event instant including DST boundaries", () => {
  assert.equal(
    timestampSnapshot(new Date("2026-03-08T06:59:59Z"), "America/New_York").offset,
    "-05:00",
  );
  assert.equal(
    timestampSnapshot(new Date("2026-03-08T07:00:00Z"), "America/New_York").offset,
    "-04:00",
  );
  assert.equal(
    timestampSnapshot(new Date("2026-11-01T05:59:59Z"), "America/New_York").offset,
    "-04:00",
  );
  assert.equal(
    timestampSnapshot(new Date("2026-11-01T06:00:00Z"), "America/New_York").offset,
    "-05:00",
  );
  assert.equal(
    timestampSnapshot(new Date("2026-01-01T00:00:00Z"), "Asia/Kolkata").offset,
    "+05:30",
  );
  assert.equal(timestampSnapshot(new Date("2026-01-01T00:00:00Z"), "UTC").offset, "+00:00");
  assert.equal(validTimezone("Made/Up"), false);
  assert.throws(() => timestampSnapshot(new Date(), "+05:00"));
});
