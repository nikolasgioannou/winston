import { describe, expect, test } from "bun:test";
import { refFor } from "@winston/db/external-refs";
import {
  inRollback,
  insertConnection,
  insertUser,
  testDb,
} from "@winston/db/testing";
import { setupApi } from "./testing.ts";

const db = await testDb();

interface TriggerDto {
  id: string;
  kind: string;
  status: string;
  at: string | null;
  on: string | null;
  account: string | null;
  scope: string | null;
  filter: Record<string, unknown>;
  maxFires: number | null;
  nextFireAt: string | null;
}

async function api(tx: Parameters<typeof setupApi>[0]) {
  const user = await insertUser(tx, { timezone: "America/New_York" });
  const mail = await insertConnection(tx, user.id, {
    externalEmail: "me@example.com",
  });
  const call = setupApi(tx).as(user.id);
  const create = async (body: Record<string, unknown>) => {
    const response = await call("/v1/triggers", {
      method: "POST",
      body: { note: "Do the thing.", ...body },
    });
    const json = (await response.json()) as {
      trigger?: TriggerDto;
      error?: { code: string; message: string; hint: string | null };
    };
    return { status: response.status, ...json };
  };
  return { user, mail, call, create };
}

describe("trigger routes", () => {
  test("a one-off --at is read in the user's zone and fires once; a cron has its next time", async () => {
    await inRollback(db, async (tx) => {
      const { create } = await api(tx);
      const once = await create({ at: "2031-03-03T14:45" });
      expect(once.trigger).toMatchObject({
        kind: "schedule",
        at: "2031-03-03T19:45:00.000Z",
        nextFireAt: "2031-03-03T19:45:00.000Z",
        maxFires: 1,
      });
      const daily = await create({ cron: "0 8 * * 1-5" });
      expect(daily.trigger?.maxFires).toBeNull();
      const next = new Date(daily.trigger?.nextFireAt ?? "");
      expect(next.getTime()).toBeGreaterThan(Date.now());
      // 8:00 in New York is 12:00 or 13:00 UTC, depending on DST.
      expect([12, 13]).toContain(next.getUTCHours());
    });
  });

  test("a subscription keeps its filters, account and scope", async () => {
    await inRollback(db, async (tx) => {
      const { user, mail, create } = await api(tx);
      const thread = await refFor(tx, user.id, mail.id, "thread", "t1");
      const created = await create({
        on: "mail.message.received",
        filter: { from: "dana", unread: true },
        scope: thread,
        maxFires: 1,
        expires: "2031-03-07T09:00",
        onExpire: "Dana never replied; offer a nudge.",
      });
      expect(created.trigger).toMatchObject({
        kind: "subscription",
        on: "mail.message.received",
        filter: { from: "dana", unread: true },
        scope: thread,
        account: "me@example.com",
        maxFires: 1,
        nextFireAt: null,
      });
    });
  });

  test("every rule is checked, with an error that says what to do", async () => {
    await inRollback(db, async (tx) => {
      const { user, create } = await api(tx);
      const calendar = await insertConnection(tx, user.id, {
        domain: "calendar",
      });
      const event = await refFor(
        tx,
        user.id,
        calendar.id,
        "calendarEvent",
        "e1",
      );
      const cases: [Record<string, unknown>, string][] = [
        [{}, "exactly one of --at"],
        [{ at: "tomorrow 9am", cron: "0 8 * * *" }, "exactly one of --at"],
        [
          { on: "mail.message.deleted" },
          "There's no event mail.message.deleted",
        ],
        [{ on: "user_message" }, "always delivered"],
        [
          { on: "calendar.event.created", filter: { unread: true } },
          "--unread isn't a filter for calendar.event.created.",
        ],
        [
          { on: "mail.message.received", filter: { from: true } },
          "--from needs a value",
        ],
        [
          { on: "mail.message.received", filter: { unread: "yes" } },
          "--unread is a switch",
        ],
        [
          { on: "mail.message.received", lead: 15 },
          "--lead only applies to calendar.event.starting.",
        ],
        [{ on: "calendar.event.starting" }, "needs --lead"],
        [
          { on: "calendar.event.created", native: "is:unread" },
          "--native is a mail search query",
        ],
        [{ on: "mail.message.received", scope: event }, "must be a thr_ id"],
        [
          { on: "calendar.invitation.received", scope: event },
          "can't be scoped",
        ],
        [
          { at: "2031-03-03T14:45", onExpire: "x" },
          "--on-expire needs --expires",
        ],
        [
          { cron: "0 8 * * *", filter: { from: "dana" } },
          "is a filter for subscriptions",
        ],
        [{ cron: "0 8 * * *", scope: event }, "--scope is for subscriptions"],
        [{ at: "2020-01-01T09:00" }, "is in the past"],
        [{ cron: "0 25 * * *" }, "isn't a valid cron pattern"],
        [
          { at: "2031-03-03T14:45", expires: "2031-03-02T09:00" },
          "before --at",
        ],
        [
          { on: "system.settings.changed", account: "me@example.com" },
          "--account doesn't apply",
        ],
      ];
      for (const [body, message] of cases) {
        const result = await create(body);
        expect({ body, message: result.error?.message }).toEqual({
          body,
          message: expect.stringContaining(message) as string,
        });
      }
      expect(
        (
          await create({
            on: "calendar.event.created",
            filter: { unread: true },
          })
        ).error?.hint,
      ).toBe("See winston events catalog calendar.");
    });
  });

  test("list shows active ones unless --all, get shows one, update recomputes, delete ends it", async () => {
    await inRollback(db, async (tx) => {
      const { call, create } = await api(tx);
      const daily = await create({ cron: "0 8 * * 1-5" });
      const sub = await create({ on: "mail.message.sent" });
      const id = daily.trigger?.id ?? "";
      const subId = sub.trigger?.id ?? "";
      const list = async (query = "") =>
        (
          (await (await call(`/v1/triggers${query}`)).json()) as {
            triggers: TriggerDto[];
          }
        ).triggers.map((t) => t.id);
      expect((await list()).sort()).toEqual([id, subId].sort());
      expect(await list("?kind=subscription")).toEqual([subId]);

      const updated = (await (
        await call(`/v1/triggers/${id}`, {
          method: "PATCH",
          body: { cron: "30 6 * * *", note: "Earlier briefing." },
        })
      ).json()) as { trigger: TriggerDto & { cron: string; note: string } };
      expect(updated.trigger).toMatchObject({
        cron: "30 6 * * *",
        note: "Earlier briefing.",
      });
      const switching = await call(`/v1/triggers/${id}`, {
        method: "PATCH",
        body: { on: "mail.message.sent" },
      });
      expect(switching.status).toBe(400);

      await call(`/v1/triggers/${id}`, { method: "DELETE" });
      expect(await list("?all=true")).toEqual([subId]);
      expect((await call(`/v1/triggers/${id}`)).status).toBe(404);
    });
  });
});
