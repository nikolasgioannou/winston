import { describe, expect, test } from "bun:test";
import {
  inRollback,
  insertConnection,
  insertUser,
  testDb,
} from "@winston/db/testing";
import { setupApi as setup } from "./testing.ts";

const db = await testDb();
describe("mail routes", () => {
  test("list passes the filters with times resolved in the user's zone, and returns stable ids", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx, { timezone: "America/New_York" });
      await insertConnection(tx, user.id, {
        scopes: ["gmail.modify"],
        externalEmail: "me@example.com",
      });
      const { as, mail } = setup(tx);
      const call = as(user.id);
      const response = await call(
        "/v1/mail/messages?in=all&from=dana&unread=true&since=2026-09-20&limit=2",
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        account: { email: string };
        messages: { id: string; threadId: string; attachmentCount: number }[];
        cursor: string;
        estimatedTotal: number;
      };
      expect(mail.filters[0]).toMatchObject({
        folder: "all",
        from: "dana",
        unread: true,
        since: new Date("2026-09-20T04:00:00Z"),
      });
      expect(body.account.email).toBe("me@example.com");
      expect(body.cursor).toBe("next-page");
      expect(body.estimatedTotal).toBe(7);
      expect(body.messages.map((m) => m.id.slice(0, 4))).toEqual([
        "msg_",
        "msg_",
      ]);
      expect(body.messages[0]?.threadId).toStartWith("thr_");
      expect(body.messages[0]?.attachmentCount).toBe(1);

      // The same messages keep their ids.
      const again = (await (
        await call("/v1/mail/messages?in=all")
      ).json()) as typeof body;
      expect(again.messages.map((m) => m.id)).toEqual(
        body.messages.map((m) => m.id),
      );
    });
  });

  test("get takes a message or a whole thread by CLI id, with attachments as att_ ids", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      await insertConnection(tx, user.id, { scopes: ["gmail.modify"] });
      const call = setup(tx).as(user.id);
      const list = (await (await call("/v1/mail/messages")).json()) as {
        messages: { id: string; threadId: string }[];
      };
      const [first] = list.messages;
      const single = (await (
        await call(`/v1/mail/messages/${first?.id ?? ""}`)
      ).json()) as {
        kind: string;
        messages: { body: string; attachments: { id: string }[] }[];
      };
      expect(single.kind).toBe("message");
      expect(single.messages[0]?.body).toBe("Body of m-1");
      const thread = (await (
        await call(`/v1/mail/messages/${first?.threadId ?? ""}`)
      ).json()) as typeof single;
      expect(thread.kind).toBe("thread");
      expect(thread.messages).toHaveLength(2);
    });
  });

  test("attachments: metadata, then saved onto the VM under /home/winston only", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      await insertConnection(tx, user.id, { scopes: ["gmail.modify"] });
      const { as, written } = setup(tx);
      const call = as(user.id);
      const list = (await (await call("/v1/mail/messages")).json()) as {
        messages: { id: string }[];
      };
      const detail = (await (
        await call(`/v1/mail/messages/${list.messages[0]?.id ?? ""}`)
      ).json()) as {
        messages: { attachments: { id: string }[] }[];
      };
      const attachment = detail.messages[0]?.attachments[0]?.id ?? "";
      expect(attachment).toStartWith("att_");
      expect(
        await (await call(`/v1/mail/attachments/${attachment}`)).json(),
      ).toEqual({
        id: attachment,
        filename: "lease.pdf",
        mimeType: "application/pdf",
        size: 3,
      });
      const saved = await call(`/v1/mail/attachments/${attachment}/save`, {
        method: "POST",
        body: { path: "/home/winston/downloads/lease.pdf" },
      });
      expect(await saved.json()).toEqual({
        id: attachment,
        path: "/home/winston/downloads/lease.pdf",
        size: 3,
      });
      expect(written).toMatchObject([
        { userId: user.id, path: "/home/winston/downloads/lease.pdf" },
      ]);
      const outside = await call(`/v1/mail/attachments/${attachment}/save`, {
        method: "POST",
        body: { path: "/etc/passwd" },
      });
      expect(outside.status).toBe(400);
    });
  });

  test("errors: no account, ambiguity, reading off, expired, a bad time, and someone else's id", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const other = await insertUser(tx);
      const { as } = setup(tx);
      const call = as(user.id);
      const code = async (path: string) =>
        ((await (await call(path)).json()) as { error: { code: string } }).error
          .code;

      expect(await code("/v1/mail/messages")).toBe("not_found");
      const off = await insertConnection(tx, user.id, {
        scopes: ["gmail.modify"],
        capabilities: { read: false },
        externalEmail: "off@example.com",
      });
      expect(await code("/v1/mail/messages")).toBe("permission_disabled");
      await insertConnection(tx, user.id, {
        scopes: ["gmail.modify"],
        status: "expired",
        externalEmail: "old@example.com",
      });
      expect(await code("/v1/mail/messages")).toBe("invalid_request");
      expect(await code("/v1/mail/messages?account=old@example.com")).toBe(
        "auth_expired",
      );
      expect(await code(`/v1/mail/messages?account=${off.id}`)).toBe(
        "permission_disabled",
      );

      const theirs = await insertConnection(tx, other.id, {
        scopes: ["gmail.modify"],
      });
      const otherCall = as(other.id);
      const theirList = (await (
        await otherCall("/v1/mail/messages")
      ).json()) as {
        messages: { id: string }[];
      };
      expect(theirs.id).toStartWith("acct_");
      expect(
        await code(`/v1/mail/messages/${theirList.messages[0]?.id ?? ""}`),
      ).toBe("not_found");
      expect(
        (
          (await (
            await otherCall("/v1/mail/messages?since=someday")
          ).json()) as { error: { code: string } }
        ).error.code,
      ).toBe("invalid_request");
    });
  });
});
