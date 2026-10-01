import { describe, expect, test } from "bun:test";
import { readOnlyQuery } from "./ops.ts";
import { testDb } from "./testing.ts";

const db = await testDb();

describe("readOnlyQuery", () => {
  test("returns rows", async () => {
    expect([...(await readOnlyQuery(db, "select 1 as one"))]).toEqual([
      { one: 1 },
    ]);
  });

  test("refuses to change anything", async () => {
    const error = await readOnlyQuery(
      db,
      "insert into allowed_emails (email) values ('x@y.z')",
    ).catch((caught: unknown) => caught);
    // Drizzle wraps Postgres's error.
    expect(String((error as Error).cause)).toContain("read-only transaction");
  });
});
