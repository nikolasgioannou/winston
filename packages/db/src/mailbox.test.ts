import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  changeMailboxAddress,
  checkMailboxName,
  mailboxState,
  retireMailboxAddresses,
  turnOffMailbox,
  turnOnMailbox,
} from "./mailbox.ts";
import {
  connections,
  inboundItems,
  mailboxAddresses,
  retiredMailboxAddresses,
  triggers,
  users,
} from "./schema/index.ts";
import { inRollback, insertUser, testDb } from "./testing.ts";

const db = await testDb();

const eventsOf = (
  tx: Parameters<Parameters<typeof inRollback>[1]>[0],
  userId: string,
) =>
  tx
    .select({ type: inboundItems.type, payload: inboundItems.payload })
    .from(inboundItems)
    .where(eq(inboundItems.userId, userId));

describe("Winston's mailbox", () => {
  test("turning it on takes the name, as a mail connection Winston hears about", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      expect(await mailboxState(tx, user.id)).toEqual({ status: "never" });
      expect(await turnOnMailbox(tx, user.id, " Ada.L ")).toEqual({
        ok: true,
        address: "ada.l@runwinston.email",
      });
      const [row] = await tx
        .select()
        .from(connections)
        .where(eq(connections.userId, user.id));
      expect(row).toMatchObject({
        domain: "mail",
        provider: "winston",
        externalEmail: "ada.l@runwinston.email",
        status: "ok",
        tokenCiphertext: null,
        capabilities: {
          read: true,
          draft: true,
          send: true,
          modify_labels: true,
        },
      });
      expect(await mailboxState(tx, user.id)).toEqual({
        status: "on",
        address: "ada.l@runwinston.email",
        aliases: [],
        changesLeft: 2,
      });
      expect((await eventsOf(tx, user.id)).map((e) => e.type)).toEqual([
        "system.app.connected",
      ]);
    });
  });

  test("a name is refused when it's invalid, reserved or anyone's", async () => {
    await inRollback(db, async (tx) => {
      const ada = await insertUser(tx);
      const bob = await insertUser(tx);
      await turnOnMailbox(tx, ada.id, "ada");
      expect(await checkMailboxName(tx, "ADA")).toEqual({
        ok: false,
        problem: "taken",
      });
      expect(await turnOnMailbox(tx, bob.id, "ada")).toEqual({
        ok: false,
        problem: "taken",
      });
      expect(await turnOnMailbox(tx, bob.id, "postmaster")).toEqual({
        ok: false,
        problem: "reserved",
      });
      expect(await turnOnMailbox(tx, bob.id, "a")).toEqual({
        ok: false,
        problem: "too_short",
      });
      // Nothing was left behind by the refusals.
      expect(await mailboxState(tx, bob.id)).toEqual({ status: "never" });
      expect(await checkMailboxName(tx, "bob")).toEqual({
        ok: true,
        address: "bob@runwinston.email",
      });
    });
  });

  test("changing the address keeps the old one as an alias, twice at most", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const other = await insertUser(tx);
      await turnOnMailbox(tx, user.id, "ada");
      await turnOnMailbox(tx, other.id, "bob");
      expect(await changeMailboxAddress(tx, user.id, "ada")).toEqual({
        ok: false,
        problem: "same",
      });
      expect(await changeMailboxAddress(tx, user.id, "bob")).toEqual({
        ok: false,
        problem: "taken",
      });
      expect(await changeMailboxAddress(tx, user.id, "ada.l")).toEqual({
        ok: true,
        address: "ada.l@runwinston.email",
        changesLeft: 1,
      });
      expect(await changeMailboxAddress(tx, user.id, "lovelace")).toMatchObject(
        { ok: true, changesLeft: 0 },
      );
      expect(await changeMailboxAddress(tx, user.id, "ada.2")).toEqual({
        ok: false,
        problem: "no_changes_left",
      });
      // Going back to an old address isn't a way round the limit, either.
      expect(await changeMailboxAddress(tx, user.id, "ada")).toEqual({
        ok: false,
        problem: "no_changes_left",
      });
      expect(await mailboxState(tx, user.id)).toEqual({
        status: "on",
        address: "lovelace@runwinston.email",
        aliases: ["ada@runwinston.email", "ada.l@runwinston.email"],
        changesLeft: 0,
      });
      const changes = (await eventsOf(tx, user.id)).filter(
        (e) => e.type === "system.settings.changed",
      );
      expect(changes.map((e) => e.payload)).toEqual([
        {
          field: "mailbox_address",
          old: "ada@runwinston.email",
          new: "ada.l@runwinston.email",
          source: "site",
        },
        {
          field: "mailbox_address",
          old: "ada.l@runwinston.email",
          new: "lovelace@runwinston.email",
          source: "site",
        },
      ]);
    });
  });

  test("turning it off ends its subscriptions; turning it on again brings the same address back", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      await turnOnMailbox(tx, user.id, "ada");
      const [mailbox] = await tx
        .select({ id: connections.id })
        .from(connections)
        .where(eq(connections.userId, user.id));
      await tx.insert(triggers).values({
        userId: user.id,
        kind: "subscription",
        eventType: "mail.message.received",
        connectionId: mailbox?.id ?? "",
        note: "Codes from GitHub",
      });
      expect(await turnOffMailbox(tx, user.id)).toBe(true);
      expect(await turnOffMailbox(tx, user.id)).toBe(false);
      expect(await mailboxState(tx, user.id)).toMatchObject({
        status: "off",
        address: "ada@runwinston.email",
      });
      const [trigger] = await tx
        .select({ status: triggers.status })
        .from(triggers)
        .where(eq(triggers.userId, user.id));
      expect(trigger?.status).toBe("deleted");

      expect(await turnOnMailbox(tx, user.id, "ignored")).toEqual({
        ok: true,
        address: "ada@runwinston.email",
      });
      expect(await turnOnMailbox(tx, user.id)).toEqual({
        ok: false,
        problem: "already_on",
      });
      expect(await checkMailboxName(tx, "ignored")).toMatchObject({ ok: true });
      expect((await eventsOf(tx, user.id)).map((e) => e.type)).toEqual([
        "system.app.connected",
        "system.app.disconnected",
        "system.app.connected",
      ]);
    });
  });

  test("a deleted user's addresses stay taken for good, kept only as hashes", async () => {
    await inRollback(db, async (tx) => {
      const ada = await insertUser(tx);
      await turnOnMailbox(tx, ada.id, "ada");
      await changeMailboxAddress(tx, ada.id, "ada.l");
      expect(await retireMailboxAddresses(tx, ada.id)).toBe(2);
      expect(await retireMailboxAddresses(tx, ada.id)).toBe(2);
      await tx.delete(users).where(eq(users.id, ada.id));
      expect(
        await tx
          .select()
          .from(mailboxAddresses)
          .where(eq(mailboxAddresses.address, "ada@runwinston.email")),
      ).toEqual([]);
      const retired = await tx
        .select({ hash: retiredMailboxAddresses.addressHash })
        .from(retiredMailboxAddresses);
      expect(retired.map((r) => r.hash)).not.toContain("ada@runwinston.email");

      const bob = await insertUser(tx);
      for (const name of ["ada", "ada.l"])
        expect(await turnOnMailbox(tx, bob.id, name)).toEqual({
          ok: false,
          problem: "taken",
        });
    });
  });
});
