/**
 * Winston's own mailbox (ead827, docs/design.md §5 Connections): a mail
 * connection with provider `winston`, and every address it has had. The
 * user turns it on from the site with a name, may change the name twice
 * (old addresses keep delivering), and may turn it off and on again. No
 * address is ever freed: deleting the account retires its addresses' hashes.
 */
import { createHash } from "node:crypto";
import { winstonMailboxCapabilities } from "@winston/domain/connections";
import {
  mailboxAddress,
  mailboxNameProblem,
  maxAddressChanges,
  normalizeMailboxName,
  type MailboxNameProblem,
} from "@winston/domain/mailbox";
import { and, asc, eq } from "drizzle-orm";
import type { DbOrTx } from "./client.ts";
import { endConnection, recordConnected } from "./connections.ts";
import { newId } from "./ids.ts";
import {
  connections,
  mailboxAddresses,
  retiredMailboxAddresses,
  users,
} from "./schema/index.ts";
import { recordSystemEvent } from "./system-events.ts";

/** Why a name can't be had: its own problem, or someone has (or had) it. */
export type MailboxNameRefusal = MailboxNameProblem | "taken";

export type MailboxNameCheck =
  { ok: true; address: string } | { ok: false; problem: MailboxNameRefusal };

/** The user's mailbox as the site shows it. */
export type MailboxState =
  | { status: "never" }
  | {
      status: "on" | "off";
      address: string;
      /** Earlier addresses, which still deliver, oldest first. */
      aliases: string[];
      changesLeft: number;
    };

const isWinston = eq(connections.provider, "winston");

/** Whether `name` could become an address now. */
export async function checkMailboxName(
  db: DbOrTx,
  name: string,
): Promise<MailboxNameCheck> {
  const normalized = normalizeMailboxName(name);
  const problem = mailboxNameProblem(normalized);
  if (problem) return { ok: false, problem };
  const address = mailboxAddress(normalized);
  const [held] = await db
    .select({ address: mailboxAddresses.address })
    .from(mailboxAddresses)
    .where(eq(mailboxAddresses.address, address));
  const [retired] = held
    ? []
    : await db
        .select({ hash: retiredMailboxAddresses.addressHash })
        .from(retiredMailboxAddresses)
        .where(eq(retiredMailboxAddresses.addressHash, addressHash(address)));
  return held || retired
    ? { ok: false, problem: "taken" }
    : { ok: true, address };
}

const addressHash = (address: string) =>
  createHash("sha256").update(address).digest("hex");

/**
 * Keeps a deleted account's addresses from ever being taken again, by hash
 * (account deletion calls this before deleting the user, whose address rows
 * go with them). Safe to repeat.
 */
export async function retireMailboxAddresses(db: DbOrTx, userId: string) {
  const held = await db
    .select({ address: mailboxAddresses.address })
    .from(mailboxAddresses)
    .where(eq(mailboxAddresses.userId, userId));
  if (held.length === 0) return 0;
  await db
    .insert(retiredMailboxAddresses)
    .values(held.map((h) => ({ addressHash: addressHash(h.address) })))
    .onConflictDoNothing();
  return held.length;
}

async function mailboxRow(db: DbOrTx, userId: string) {
  const [row] = await db
    .select({
      id: connections.id,
      externalEmail: connections.externalEmail,
      status: connections.status,
    })
    .from(connections)
    .where(and(eq(connections.userId, userId), isWinston));
  return row;
}

/** The user's mailbox: never set up, or on or off with its addresses. */
export async function mailboxState(
  db: DbOrTx,
  userId: string,
): Promise<MailboxState> {
  const row = await mailboxRow(db, userId);
  if (!row) return { status: "never" };
  const held = await db
    .select({ address: mailboxAddresses.address })
    .from(mailboxAddresses)
    .where(eq(mailboxAddresses.connectionId, row.id))
    .orderBy(asc(mailboxAddresses.createdAt), asc(mailboxAddresses.address));
  const aliases = held
    .map((h) => h.address)
    .filter((address) => address !== row.externalEmail);
  return {
    status: row.status === "disconnected" ? "off" : "on",
    address: row.externalEmail,
    aliases,
    changesLeft: Math.max(0, maxAddressChanges - aliases.length),
  };
}

/** Claims `address` for good, or returns false if anyone ever had it. */
async function claim(
  tx: DbOrTx,
  address: string,
  userId: string,
  connectionId: string,
) {
  const [claimed] = await tx
    .insert(mailboxAddresses)
    // The clock, not the transaction's start, so aliases taken together still order.
    .values({ address, userId, connectionId, createdAt: new Date() })
    .onConflictDoNothing()
    .returning({ address: mailboxAddresses.address });
  return claimed !== undefined;
}

export type TurnOnResult =
  | { ok: true; address: string }
  | { ok: false; problem: MailboxNameRefusal | "already_on" };

/**
 * Turns Winston's mailbox on. The first time it takes `name`; after that
 * the mailbox comes back with the address it had, and `name` is ignored.
 * Winston is told (`system.app.connected`).
 */
export async function turnOnMailbox(
  db: DbOrTx,
  userId: string,
  name?: string,
): Promise<TurnOnResult> {
  return db.transaction(async (tx) => {
    // One mailbox per user: holding the user's row makes a second turn-on
    // wait, then find the first one's mailbox.
    await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .for("update");
    const existing = await mailboxRow(tx, userId);
    if (existing) {
      if (existing.status !== "disconnected")
        return { ok: false, problem: "already_on" };
      await tx
        .update(connections)
        .set({ status: "ok", grantedAt: new Date() })
        .where(eq(connections.id, existing.id));
      await recordConnected(
        tx,
        userId,
        existing.id,
        `reconnected:${String(Date.now())}`,
      );
      return { ok: true, address: existing.externalEmail };
    }

    const check = await checkMailboxName(tx, name ?? "");
    if (!check.ok) return check;
    const id = newId("connection");
    await tx.insert(connections).values({
      id,
      userId,
      domain: "mail",
      provider: "winston",
      externalEmail: check.address,
      capabilities: winstonMailboxCapabilities,
      grantedAt: new Date(),
      status: "ok",
    });
    // Lost a race for the name: undo the mailbox too.
    if (!(await claim(tx, check.address, userId, id))) {
      await tx.delete(connections).where(eq(connections.id, id));
      return { ok: false, problem: "taken" };
    }
    await recordConnected(tx, userId, id, "connected");
    return { ok: true, address: check.address };
  });
}

export type ChangeAddressResult =
  | { ok: true; address: string; changesLeft: number }
  | {
      ok: false;
      problem: MailboxNameRefusal | "no_mailbox" | "no_changes_left" | "same";
    };

/**
 * Gives the mailbox a new address. The old one stays the mailbox's and keeps
 * delivering; a user may do this `maxAddressChanges` times in all. Winston
 * is told (`system.settings.changed`, field `mailbox_address`).
 */
export async function changeMailboxAddress(
  db: DbOrTx,
  userId: string,
  name: string,
): Promise<ChangeAddressResult> {
  return db.transaction(async (tx) => {
    const state = await mailboxState(tx, userId);
    if (state.status === "never") return { ok: false, problem: "no_mailbox" };
    const row = await mailboxRow(tx, userId);
    if (!row) return { ok: false, problem: "no_mailbox" };
    if (mailboxAddress(normalizeMailboxName(name)) === state.address)
      return { ok: false, problem: "same" };
    if (state.changesLeft === 0)
      return { ok: false, problem: "no_changes_left" };
    const check = await checkMailboxName(tx, name);
    if (!check.ok) return check;
    if (!(await claim(tx, check.address, userId, row.id)))
      return { ok: false, problem: "taken" };
    await tx
      .update(connections)
      .set({ externalEmail: check.address })
      .where(eq(connections.id, row.id));
    await recordSystemEvent(tx, {
      userId,
      type: "system.settings.changed",
      payload: {
        field: "mailbox_address",
        old: state.address,
        new: check.address,
        source: "site",
      },
      sourceRef: `connection:${row.id}:address:${check.address}`,
    });
    return {
      ok: true,
      address: check.address,
      changesLeft: state.changesLeft - 1,
    };
  });
}

/**
 * Turns the mailbox off: it stops sending and receiving, but keeps its
 * addresses. Subscriptions tied to it end, and Winston is told
 * (`system.app.disconnected`). Returns false if it wasn't on.
 */
export async function turnOffMailbox(db: DbOrTx, userId: string) {
  return db.transaction(async (tx) => {
    const [off] = await tx
      .update(connections)
      .set({ status: "disconnected" })
      .where(
        and(
          eq(connections.userId, userId),
          isWinston,
          eq(connections.status, "ok"),
        ),
      )
      .returning({ id: connections.id });
    if (!off) return false;
    await endConnection(tx, userId, off.id);
    return true;
  });
}
