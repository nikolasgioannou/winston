import { describe, expect, test } from "bun:test";
import { refFor } from "@winston/db/external-refs";
import { auditLog } from "@winston/db/schema";
import {
  inRollback,
  insertConnection,
  insertRun,
  insertUser,
  testDb,
} from "@winston/db/testing";
import { eq } from "drizzle-orm";
import { setupApi } from "./testing.ts";

const db = await testDb();
const everything = { read: true, draft: true, send: true, modify_labels: true };

type Json = Record<string, unknown>;
const json = async (response: Response) => (await response.json()) as Json;
const errorCode = async (response: Response) =>
  ((await response.json()) as { error: { code: string } }).error.code;

describe("mail writes", () => {
  test("send attaches files from the VM, returns the new ids, and is on the audit log with the body redacted", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const run = await insertRun(tx, user.id);
      const connection = await insertConnection(tx, user.id, {
        scopes: ["gmail.modify"],
        capabilities: everything,
      });
      const { as, mail } = setupApi(tx, {
        "/home/winston/notes/plan.txt": "the plan",
      });
      const response = await as(user.id, run.id)("/v1/mail/send", {
        method: "POST",
        body: {
          to: ["dana@example.com"],
          cc: ["sam@example.com"],
          subject: "Plan",
          body: "Here it is.",
          attach: ["/home/winston/notes/plan.txt"],
        },
      });
      expect(response.status).toBe(200);
      const body = await json(response);
      expect((body.sent as { id: string }).id).toStartWith("msg_");
      expect((body.sent as { threadId: string }).threadId).toStartWith("thr_");
      expect(mail.sent[0]).toMatchObject({
        to: ["dana@example.com"],
        cc: ["sam@example.com"],
        subject: "Plan",
      });
      expect(mail.sent[0]?.attachments?.[0]).toMatchObject({
        filename: "plan.txt",
        mimeType: "text/plain",
      });
      const [row] = await tx
        .select()
        .from(auditLog)
        .where(eq(auditLog.connectionId, connection.id));
      expect(row).toMatchObject({
        runId: run.id,
        action: "mail.send",
        outcome: "ok",
        resultRef: "m-sent",
        summary: "Sent to dana@example.com, sam@example.com: Plan",
      });
      expect(row?.request).toMatchObject({
        body: "[11 characters]",
        attachments: ["plan.txt"],
      });
    });
  });

  test("a dry run shows exactly what would go, and sends and records nothing", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      await insertConnection(tx, user.id, {
        scopes: ["gmail.modify"],
        capabilities: everything,
        externalEmail: "me@example.com",
      });
      const { as, mail } = setupApi(tx);
      const body = await json(
        await as(user.id, (await insertRun(tx, user.id)).id)("/v1/mail/send", {
          method: "POST",
          body: {
            to: ["dana@example.com"],
            subject: "Plan",
            body: "Here.",
            dryRun: true,
          },
        }),
      );
      expect(body.preview).toEqual({
        dryRun: true,
        draft: false,
        account: "me@example.com",
        to: ["dana@example.com"],
        cc: [],
        bcc: [],
        subject: "Plan",
        body: "Here.",
        attachments: [],
        threadId: null,
      });
      expect(mail.sent).toEqual([]);
      expect(await tx.select().from(auditLog)).toEqual([]);
    });
  });

  test("with sending off, a send is refused (exit 3) but --draft still works", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      await insertConnection(tx, user.id, {
        scopes: ["gmail.modify"],
        capabilities: { read: true, draft: true, send: false },
      });
      const { as, mail } = setupApi(tx);
      const call = as(user.id, (await insertRun(tx, user.id)).id);
      const input = { to: ["dana@example.com"], subject: "Hi", body: "Hi" };
      const refused = await call("/v1/mail/send", {
        method: "POST",
        body: input,
      });
      expect(refused.status).toBe(403);
      expect(await errorCode(refused)).toBe("permission_disabled");
      const drafted = await json(
        await call("/v1/mail/send", {
          method: "POST",
          body: { ...input, draft: true },
        }),
      );
      expect((drafted.draft as { id: string }).id).toStartWith("drf_");
      expect(mail.drafted).toHaveLength(1);
      expect(mail.sent).toEqual([]);
    });
  });

  test("reply threads to the original and answers the sender; reply-all copies the rest", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const connection = await insertConnection(tx, user.id, {
        scopes: ["gmail.modify"],
        capabilities: everything,
        externalEmail: "me@example.com",
      });
      const { as, mail } = setupApi(tx);
      const id = await refFor(tx, user.id, connection.id, "message", "m-1");
      const body = await json(
        await as(user.id, (await insertRun(tx, user.id)).id)(
          `/v1/mail/messages/${id}/reply`,
          {
            method: "POST",
            body: { body: "Tuesday works." },
          },
        ),
      );
      expect(mail.sent[0]).toMatchObject({
        to: ["Dana Reyes <dana@example.com>"],
        subject: "Re: Subject m-1",
        inReplyTo: {
          threadId: "t-1",
          messageIdHeader: "<m-1@mail.example.com>",
        },
      });
      expect((body.sent as { threadId: string }).threadId).toBe(
        await refFor(tx, user.id, connection.id, "thread", "t-1"),
      );
      const [row] = await tx
        .select()
        .from(auditLog)
        .where(eq(auditLog.userId, user.id));
      expect(row).toMatchObject({ action: "mail.reply", targetRef: id });
    });
  });

  test("forward keeps the original's attachments; its dry run names them", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const connection = await insertConnection(tx, user.id, {
        scopes: ["gmail.modify"],
        capabilities: everything,
      });
      const { as, mail } = setupApi(tx);
      const id = await refFor(tx, user.id, connection.id, "message", "m-1");
      const call = as(user.id, (await insertRun(tx, user.id)).id);
      const preview = await json(
        await call(`/v1/mail/messages/${id}/forward`, {
          method: "POST",
          body: { to: ["lawyer@example.com"], body: "FYI", dryRun: true },
        }),
      );
      expect(
        (preview.preview as { attachments: string[]; subject: string })
          .attachments,
      ).toEqual(["lease.pdf"]);
      expect((preview.preview as { subject: string }).subject).toBe(
        "Fwd: Subject m-1",
      );
      await call(`/v1/mail/messages/${id}/forward`, {
        method: "POST",
        body: { to: ["lawyer@example.com"] },
      });
      expect(mail.sent[0]?.attachments?.map((a) => a.filename)).toEqual([
        "lease.pdf",
      ]);
      expect(mail.sent[0]?.body).toContain(
        "---------- Forwarded message ---------",
      );
    });
  });

  test("a draft is sent by its drf_ id", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const connection = await insertConnection(tx, user.id, {
        scopes: ["gmail.modify"],
        capabilities: everything,
      });
      const { as, mail } = setupApi(tx);
      const draft = await refFor(tx, user.id, connection.id, "draft", "r-1");
      const body = await json(
        await as(user.id, (await insertRun(tx, user.id)).id)(
          `/v1/mail/drafts/${draft}/send`,
          {
            method: "POST",
            body: {},
          },
        ),
      );
      expect(mail.draftsSent).toEqual(["r-1"]);
      expect((body.sent as { id: string }).id).toStartWith("msg_");
    });
  });

  test("update and delete act on messages and threads per account, need organizing, and move to the trash", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const connection = await insertConnection(tx, user.id, {
        scopes: ["gmail.modify"],
        capabilities: everything,
      });
      const readOnly = await insertConnection(tx, user.id, {
        scopes: ["gmail.modify"],
        capabilities: { read: true },
        externalEmail: "other@example.com",
      });
      const { as, mail } = setupApi(tx);
      const call = as(user.id, (await insertRun(tx, user.id)).id);
      const message = await refFor(
        tx,
        user.id,
        connection.id,
        "message",
        "m-1",
      );
      const thread = await refFor(tx, user.id, connection.id, "thread", "t-1");
      const draft = await refFor(tx, user.id, connection.id, "draft", "r-1");

      await call("/v1/mail/update", {
        method: "POST",
        body: {
          ids: [message, thread],
          read: true,
          archived: true,
          addLabels: ["Lease"],
        },
      });
      expect(mail.modified).toEqual([
        {
          target: { messages: ["m-1"], threads: ["t-1"] },
          changes: {
            read: true,
            archived: true,
            addLabels: ["Lease"],
            removeLabels: [],
          },
        },
      ]);
      expect(
        await errorCode(
          await call("/v1/mail/update", {
            method: "POST",
            body: { ids: [message] },
          }),
        ),
      ).toBe("invalid_request");
      const elsewhere = await refFor(
        tx,
        user.id,
        readOnly.id,
        "message",
        "m-9",
      );
      expect(
        await errorCode(
          await call("/v1/mail/update", {
            method: "POST",
            body: { ids: [elsewhere], read: true },
          }),
        ),
      ).toBe("permission_disabled");

      await call("/v1/mail/delete", {
        method: "POST",
        body: { ids: [message, draft] },
      });
      expect(mail.trashed).toEqual([
        { messages: ["m-1"], threads: [], drafts: ["r-1"] },
      ]);
      const actions = (
        await tx.select().from(auditLog).where(eq(auditLog.userId, user.id))
      ).map((r) => r.action);
      expect(actions.sort()).toEqual(["mail.delete", "mail.update"]);
    });
  });

  test("bad input is invalid_request; attachments outside home are refused", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      await insertConnection(tx, user.id, {
        scopes: ["gmail.modify"],
        capabilities: everything,
      });
      const call = setupApi(tx).as(user.id, (await insertRun(tx, user.id)).id);
      expect(
        await errorCode(
          await call("/v1/mail/send", {
            method: "POST",
            body: { subject: "x", body: "y" },
          }),
        ),
      ).toBe("invalid_request");
      expect(
        await errorCode(
          await call("/v1/mail/send", {
            method: "POST",
            body: {
              to: ["a@b.co"],
              subject: "x",
              body: "y",
              attach: ["/etc/passwd"],
            },
          }),
        ),
      ).toBe("invalid_request");
    });
  });
});
