import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { localTokenVault } from "@winston/shared/token-vault";
import {
  connectionDtoColumns,
  disconnectConnection,
  saveConnection,
  setCapability,
  toConnectionDto,
} from "./connections.ts";
import { connections, inboundItems, jobs } from "./schema/index.ts";
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
  test("connecting or reconnecting an account asks for a watch on its changes, once while queued", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const vault = localTokenVault("ab".repeat(32));
      const grant = {
        userId: user.id,
        domain: "mail" as const,
        provider: "gmail" as const,
        externalEmail: "ada@work.example",
        scopes: ["gmail.modify"],
        refreshToken: "refresh",
      };
      const { connectionId } = await saveConnection(tx, vault, grant);
      await saveConnection(tx, vault, grant);
      await saveConnection(tx, vault, {
        ...grant,
        domain: "calendar",
        provider: "google_calendar",
      });
      const watches = await tx
        .select({ payload: jobs.payload })
        .from(jobs)
        .where(eq(jobs.type, "watch_connection"));
      expect(watches).toHaveLength(2);
      expect(watches[0]?.payload).toEqual({ connectionId });
    });
  });

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
        scopes: [],
        capabilities: { read: true, send: false },
        grantedAt: "2026-09-29T12:00:00.000Z",
        status: "ok",
        createdAt: row.createdAt.toISOString(),
      });
    });
  });
});

describe("managing a connection", () => {
  const insert = async (
    tx: Parameters<Parameters<typeof inRollback>[1]>[0],
    userId: string,
    overrides = {},
  ) => {
    const [row] = await tx
      .insert(connections)
      .values(
        connection(userId, {
          capabilities: {
            read: true,
            draft: true,
            send: false,
            modify_labels: false,
          },
          ...overrides,
        }),
      )
      .returning();
    if (!row) throw new Error("expected a row");
    return row;
  };

  test("a toggle changes one capability of the user's own connection, and only its domain's", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const other = await insertUser(tx);
      const row = await insert(tx, user.id);
      expect(await setCapability(tx, user.id, row.id, "send", true)).toEqual({
        read: true,
        draft: true,
        send: true,
        modify_labels: false,
      });
      expect(
        await setCapability(tx, user.id, row.id, "rsvp", true),
      ).toBeUndefined();
      expect(
        await setCapability(tx, other.id, row.id, "send", false),
      ).toBeUndefined();
      const [after] = await tx
        .select()
        .from(connections)
        .where(eq(connections.id, row.id));
      expect(after?.capabilities.send).toBe(true);
    });
  });

  test("disconnecting marks it at once, tells Winston and queues the grant's revocation, once", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const row = await insert(tx, user.id);
      expect(await disconnectConnection(tx, user.id, row.id)).toBe(true);
      expect(await disconnectConnection(tx, user.id, row.id)).toBe(false);

      const [after] = await tx
        .select()
        .from(connections)
        .where(eq(connections.id, row.id));
      expect(after?.status).toBe("disconnected");
      const [item] = await tx
        .select()
        .from(inboundItems)
        .where(eq(inboundItems.userId, user.id));
      expect(item).toMatchObject({
        type: "system.app.disconnected",
        payload: {
          connectionId: row.id,
          domain: "mail",
          externalEmail: "ada@work.example",
        },
      });
      expect(
        (
          await tx
            .select({ type: jobs.type, payload: jobs.payload })
            .from(jobs)
            .where(eq(jobs.userId, user.id))
        ).sort((a, b) => a.type.localeCompare(b.type)),
      ).toEqual([
        { type: "front_turn", payload: {} },
        { type: "revoke_connection_token", payload: { connectionId: row.id } },
      ]);
    });
  });
});
