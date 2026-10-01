import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { audited, redactRequest } from "./audit.ts";
import { auditLog } from "./schema/index.ts";
import {
  inRollback,
  insertConnection,
  insertRun,
  insertUser,
  testDb,
} from "./testing.ts";

const db = await testDb();

describe("the audit log", () => {
  test("bodies and other free text become their length", () => {
    expect(
      redactRequest({
        to: ["dana@example.com"],
        subject: "Lease",
        body: "Tuesday works.",
      }),
    ).toEqual({
      to: ["dana@example.com"],
      subject: "Lease",
      body: "[14 characters]",
    });
  });

  test("a write is on record as pending while the provider runs, then ok with what it made", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const run = await insertRun(tx, user.id);
      const connection = await insertConnection(tx, user.id);
      let seenWhileRunning: string | undefined;
      const result = await audited(
        tx,
        {
          userId: user.id,
          runId: run.id,
          connectionId: connection.id,
          action: "mail.send",
          summary: "Sent to Dana: Lease",
          request: { to: ["dana@example.com"], body: "Tuesday works." },
        },
        async () => {
          [{ outcome: seenWhileRunning }] = (await tx
            .select({ outcome: auditLog.outcome })
            .from(auditLog)
            .where(eq(auditLog.userId, user.id))) as [{ outcome: string }];
          return { id: "gmail-msg-1" };
        },
        (sent) => sent.id,
      );
      expect(result).toEqual({ id: "gmail-msg-1" });
      expect(seenWhileRunning).toBe("pending");
      const [row] = await tx
        .select()
        .from(auditLog)
        .where(eq(auditLog.userId, user.id));
      expect(row).toMatchObject({
        action: "mail.send",
        outcome: "ok",
        resultRef: "gmail-msg-1",
        request: { to: ["dana@example.com"], body: "[14 characters]" },
      });
      expect(row?.finishedAt).toBeInstanceOf(Date);
    });
  });

  test("a failed write stays on record with the error, and the error still reaches the caller", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const connection = await insertConnection(tx, user.id);
      const failing = audited(
        tx,
        {
          userId: user.id,
          runId: null,
          connectionId: connection.id,
          action: "mail.update",
          summary: "Archived a message",
          request: { archive: true },
        },
        () => Promise.reject(new Error("Gmail said no")),
      );
      expect(failing).rejects.toThrow("Gmail said no");
      await failing.catch(() => undefined);
      const [row] = await tx
        .select()
        .from(auditLog)
        .where(eq(auditLog.userId, user.id));
      expect(row).toMatchObject({ outcome: "error", error: "Gmail said no" });
    });
  });
});
