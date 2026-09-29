import { describe, expect, test } from "bun:test";
import { hashToken } from "@winston/shared/tokens";
import { eq } from "drizzle-orm";
import { webSessions } from "./schema/index.ts";
import { inRollback, insertUser, testDb } from "./testing.ts";
import {
  createSession,
  deleteSession,
  findSession,
  sessionLifetimeMs,
} from "./web-sessions.ts";

const db = await testDb();
const now = new Date("2026-09-28T12:00:00Z");
const later = (ms: number) => new Date(now.getTime() + ms);

describe("web sessions", () => {
  test("stores only the token's hash, and finds the session by the token", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const { token, session } = await createSession(tx, user.id, now);
      expect(session.id).toStartWith("ses_");
      expect(session.tokenHash).toBe(hashToken(token));
      expect(session.tokenHash).not.toContain(token);
      expect(session.expiresAt).toEqual(later(sessionLifetimeMs));
      expect((await findSession(tx, token, now))?.userId).toBe(user.id);
      expect(await findSession(tx, `${token}x`, now)).toBeUndefined();
    });
  });

  test("an expired session isn't found", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const { token } = await createSession(tx, user.id, now);
      expect(
        await findSession(tx, token, later(sessionLifetimeMs - 1)),
      ).toBeDefined();
      expect(
        await findSession(tx, token, later(sessionLifetimeMs)),
      ).toBeUndefined();
    });
  });

  test("sign-out deletes the session", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const { token } = await createSession(tx, user.id, now);
      await deleteSession(tx, token);
      expect(await findSession(tx, token, now)).toBeUndefined();
    });
  });

  test("starting a session clears expired ones", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const old = await createSession(tx, user.id, now);
      await createSession(tx, user.id, later(sessionLifetimeMs + 1));
      const left = await tx
        .select()
        .from(webSessions)
        .where(eq(webSessions.userId, user.id));
      expect(left.map((s) => s.id)).not.toContain(old.session.id);
      expect(left).toHaveLength(1);
    });
  });
});
