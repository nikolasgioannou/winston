import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { connectionDtoColumns, toConnectionDto } from "./connections.ts";
import { connections } from "./schema/index.ts";
import { inRollback, insertUser, testDb } from "./testing.ts";

const db = await testDb();

const connection = (userId: string, overrides = {}) => ({
  userId,
  domain: "mail" as const,
  provider: "gmail" as const,
  externalEmail: "ada@work.example",
  tokenCiphertext: "local:v1:secret-ciphertext",
  grantedAt: new Date("2026-09-29T12:00:00Z"),
  ...overrides,
});

describe("connections", () => {
  test("one connection per user, domain and account", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const other = await insertUser(tx);
      await tx.insert(connections).values(connection(user.id));
      // The same account's calendar, or another user's mail, is fine.
      await tx.insert(connections).values(
        connection(user.id, {
          domain: "calendar",
          provider: "google_calendar",
        }),
      );
      await tx.insert(connections).values(connection(other.id));
      const duplicate = await tx
        .transaction((inner) =>
          inner.insert(connections).values(connection(user.id)),
        )
        .catch((e: unknown) => e);
      expect(
        String((duplicate as { cause?: unknown }).cause ?? duplicate),
      ).toContain("connections_user_id_domain_external_email_unique");
    });
  });

  test("a DTO never carries the token, whether selected or built from a whole row", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const [row] = await tx
        .insert(connections)
        .values(
          connection(user.id, { capabilities: { read: true, send: false } }),
        )
        .returning();
      if (!row) throw new Error("expected a row");

      const fromRow = JSON.stringify(toConnectionDto(row));
      const [selected] = await tx
        .select(connectionDtoColumns)
        .from(connections)
        .where(eq(connections.id, row.id));
      if (!selected) throw new Error("expected a row");
      const fromSelect = JSON.stringify(toConnectionDto(selected));

      for (const json of [fromRow, fromSelect]) {
        expect(json).not.toContain("secret-ciphertext");
        expect(json).not.toContain("tokenCiphertext");
        expect(json).not.toContain("syncState");
      }
      expect(JSON.parse(fromRow)).toEqual({
        id: row.id,
        domain: "mail",
        provider: "gmail",
        externalEmail: "ada@work.example",
        alias: null,
        scopes: [],
        capabilities: { read: true, send: false },
        grantedAt: "2026-09-29T12:00:00.000Z",
        status: "ok",
        createdAt: row.createdAt.toISOString(),
      });
    });
  });
});
