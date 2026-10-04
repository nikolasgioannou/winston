import { describe, expect, test } from "bun:test";
import {
  inRollback,
  insertConnection,
  insertUser,
  testDb,
} from "@winston/db/testing";
import { turnOnMailbox } from "@winston/db/mailbox";
import { setupApi } from "./testing.ts";

const db = await testDb();

type Json = Record<string, unknown>;
interface Account {
  id: string;
  domain: string;
  email: string;
  status: string;
  capabilities: {
    name: string;
    description: string;
    on: boolean;
    granted: boolean;
  }[];
  calendars: { name: string }[] | null;
  calendarsNote: string | null;
  notes: string[];
  links: { settings: string; reconnect: string } | null;
}

describe("accounts routes", () => {
  test("connect gives the domain's link and the accounts already connected for it", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      await insertConnection(tx, user.id, { externalEmail: "me@example.com" });
      const as = setupApi(tx).as(user.id);
      expect(await (await as("/v1/accounts/connect/mail")).json()).toEqual({
        domain: "mail",
        url: "https://runwinston.com/auth/google/connect?domain=mail",
        connected: ["me@example.com"],
        winstonMailbox: {
          status: "never",
          address: null,
          url: "https://runwinston.com/channels?email=setup",
        },
      });
      expect(
        await (await as("/v1/accounts/connect/calendar")).json(),
      ).toMatchObject({ connected: [] });
      expect((await as("/v1/accounts/connect/drive")).status).toBe(400);
    });
  });

  test("list shows connected accounts, mail first, leaving out disconnected ones", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      await insertConnection(tx, user.id, {
        domain: "calendar",
        externalEmail: "me@example.com",
        status: "expiring",
      });
      await insertConnection(tx, user.id, { externalEmail: "me@example.com" });
      await insertConnection(tx, user.id, {
        externalEmail: "old@example.com",
        status: "disconnected",
      });
      const body = (await (
        await setupApi(tx).as(user.id)("/v1/accounts")
      ).json()) as { accounts: Json[] };
      expect(
        body.accounts.map(({ domain, provider, email, status }) => ({
          domain,
          provider,
          email,
          status,
        })),
      ).toEqual([
        {
          domain: "mail",
          provider: "gmail",
          email: "me@example.com",
          status: "ok",
        },
        {
          domain: "calendar",
          provider: "google_calendar",
          email: "me@example.com",
          status: "expiring",
        },
      ]);
      expect(body.accounts[0]?.id).toStartWith("acct_");
    });
  });

  test("Winston's own mailbox is listed, but isn't one to connect or reconnect", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      await turnOnMailbox(tx, user.id, "ada");
      const as = setupApi(tx).as(user.id);
      const list = (await (await as("/v1/accounts")).json()) as {
        accounts: Json[];
      };
      expect(list.accounts).toMatchObject([
        { domain: "mail", provider: "winston", email: "ada@runwinston.email" },
      ]);
      expect(
        await (await as("/v1/accounts/connect/mail")).json(),
      ).toMatchObject({
        connected: [],
        winstonMailbox: {
          status: "on",
          address: "ada@runwinston.email",
          url: "https://runwinston.com/channels",
        },
      });
      const got = (await (
        await as("/v1/accounts/ada@runwinston.email")
      ).json()) as { accounts: Account[] };
      expect(got.accounts[0]?.links).toBeNull();
      expect(got.accounts[0]?.notes[0]).toStartWith("Winston's own mailbox");
    });
  });

  test("get by address shows both accounts on it: capabilities on, off or not granted, calendars, notes and links", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      await insertConnection(tx, user.id, {
        externalEmail: "me@example.com",
        scopes: ["gmail.modify"],
        capabilities: { read: true, draft: true, send: false },
      });
      await insertConnection(tx, user.id, {
        domain: "calendar",
        externalEmail: "me@example.com",
        scopes: ["calendar.events"],
        capabilities: { read: true, create: true },
      });
      const call = setupApi(tx).as(user.id);
      const body = (await (
        await call("/v1/accounts/Me@Example.com")
      ).json()) as { accounts: Account[] };
      const [mail, calendar] = body.accounts;
      expect(mail?.capabilities).toContainEqual({
        name: "send",
        description: "sending",
        on: false,
        granted: true,
      });
      expect(mail?.notes.join(" ")).toContain("--native");
      expect(mail?.calendars).toBeNull();
      expect(calendar?.capabilities).toContainEqual({
        name: "create",
        description: "creating events",
        on: true,
        granted: true,
      });
      expect(calendar?.calendars?.map((c) => c.name)).toEqual([
        "me@example.com",
      ]);
      expect(calendar?.links?.settings).toBe(
        `https://runwinston.com/accounts?account=${calendar?.id ?? ""}`,
      );

      const one = (await (
        await call(`/v1/accounts/${calendar?.id ?? ""}`)
      ).json()) as { accounts: Account[] };
      expect(one.accounts).toHaveLength(1);
    });
  });

  test("a scope Google never granted shows as not granted; reading off hides the calendars; unknown is not_found", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      await insertConnection(tx, user.id, {
        externalEmail: "me@example.com",
        scopes: [],
      });
      await insertConnection(tx, user.id, {
        domain: "calendar",
        externalEmail: "cal@example.com",
        scopes: ["calendar.events"],
        capabilities: { read: false },
      });
      const call = setupApi(tx).as(user.id);
      const mail = (await (
        await call("/v1/accounts/me@example.com")
      ).json()) as { accounts: Account[] };
      expect(mail.accounts[0]?.capabilities[0]).toMatchObject({
        name: "read",
        granted: false,
      });
      const calendar = (await (
        await call("/v1/accounts/cal@example.com")
      ).json()) as { accounts: Account[] };
      expect(calendar.accounts[0]?.calendarsNote).toBe(
        "Reading is off, so the calendars aren't shown.",
      );
      const missing = (await (
        await call("/v1/accounts/nobody@example.com")
      ).json()) as { error: { code: string } };
      expect(missing.error.code).toBe("not_found");
    });
  });
});
