import { describe, expect, test } from "bun:test";
import { refFor, refsFor, resolveRef } from "./external-refs.ts";
import { inRollback, insertConnection, insertUser, testDb } from "./testing.ts";

const db = await testDb();

describe("CLI ids for provider objects", () => {
  test("an object keeps its id, and the id resolves back to its connection and provider id", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const connection = await insertConnection(tx, user.id);
      const first = await refFor(
        tx,
        user.id,
        connection.id,
        "message",
        "18c2f0a9",
      );
      expect(first).toStartWith("msg_");
      expect(
        await refFor(tx, user.id, connection.id, "message", "18c2f0a9"),
      ).toBe(first);
      expect(await resolveRef(tx, user.id, first)).toEqual({
        id: first,
        userId: user.id,
        connectionId: connection.id,
        kind: "message",
        providerId: "18c2f0a9",
      });
    });
  });

  test("many at once, with each kind getting its own prefix", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const connection = await insertConnection(tx, user.id);
      const threads = await refsFor(tx, user.id, connection.id, "thread", [
        "a",
        "b",
        "a",
      ]);
      expect([...threads.keys()].sort()).toEqual(["a", "b"]);
      expect([...threads.values()].every((id) => id.startsWith("thr_"))).toBe(
        true,
      );
      const event = await refFor(
        tx,
        user.id,
        connection.id,
        "calendarEvent",
        "primary/e1",
      );
      expect(event).toStartWith("evt_");
    });
  });

  test("someone else's id doesn't resolve", async () => {
    await inRollback(db, async (tx) => {
      const owner = await insertUser(tx);
      const other = await insertUser(tx);
      const connection = await insertConnection(tx, owner.id);
      const id = await refFor(tx, owner.id, connection.id, "draft", "r-123");
      expect(await resolveRef(tx, other.id, id)).toBeUndefined();
      expect(await resolveRef(tx, owner.id, "msg_unknown")).toBeUndefined();
    });
  });
});
