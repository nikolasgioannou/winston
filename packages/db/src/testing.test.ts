import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { users } from "./schema/index.ts";
import { inRollback, insertUser, testDb, truncateAll } from "./testing.ts";

const db = await testDb();
const email = "isolation@example.com";

describe("inRollback", () => {
  test("writes inside the test are visible inside it", async () => {
    await inRollback(db, async (tx) => {
      await insertUser(tx, { email });
      expect(
        await tx.select().from(users).where(eq(users.email, email)),
      ).toHaveLength(1);
    });
  });

  test("...and gone for the next test", async () => {
    expect(await db.select().from(users).where(eq(users.email, email))).toEqual(
      [],
    );
  });
});

describe("truncateAll", () => {
  test("empties the tables", async () => {
    await insertUser(db);
    await truncateAll(db);
    expect(await db.select().from(users)).toEqual([]);
  });
});
