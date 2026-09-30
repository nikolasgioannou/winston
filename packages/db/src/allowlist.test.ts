import { describe, expect, test } from "bun:test";
import {
  allowEmail,
  disallowEmail,
  listAllowedEmails,
  normalizeEmail,
} from "./allowlist.ts";
import { inRollback, insertUser, testDb } from "./testing.ts";

const db = await testDb();

describe("the allowlist", () => {
  test("emails are trimmed, lowercased and validated", () => {
    expect(normalizeEmail("  Ada@Example.COM ")).toBe("ada@example.com");
    expect(normalizeEmail("not an email")).toBeUndefined();
    expect(normalizeEmail("")).toBeUndefined();
  });

  test("adding and removing are idempotent; removing says whether an account remains", async () => {
    await inRollback(db, async (tx) => {
      expect(await allowEmail(tx, "ada@example.com")).toBe(true);
      expect(await allowEmail(tx, "ada@example.com")).toBe(false);
      expect((await listAllowedEmails(tx)).map((row) => row.email)).toContain(
        "ada@example.com",
      );

      await insertUser(tx, { email: "ada@example.com" });
      expect(await disallowEmail(tx, "ada@example.com")).toEqual({
        wasListed: true,
        hasAccount: true,
      });
      expect(await disallowEmail(tx, "ada@example.com")).toEqual({
        wasListed: false,
        hasAccount: true,
      });
      expect(
        (await listAllowedEmails(tx)).map((row) => row.email),
      ).not.toContain("ada@example.com");
    });
  });
});
