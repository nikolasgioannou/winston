import { describe, expect, test } from "bun:test";
import { ConnectionUnavailableError } from "@winston/connectors/access-token";
import {
  NotSupportedError,
  ProviderNotFoundError,
} from "@winston/connectors/errors";
import {
  inRollback,
  insertConnection,
  insertUser,
  testDb,
} from "@winston/db/testing";
import {
  ApiFailure,
  requireCapability,
  resolveConnection,
  toApiFailure,
} from "./connections.ts";

const db = await testDb();
const web = "https://runwinston.com";

/** The failure a call throws, as code, message and hint. */
async function failure(call: () => unknown) {
  try {
    await call();
  } catch (error) {
    if (error instanceof ApiFailure)
      return { code: error.code, message: error.message, hint: error.hint };
    throw error;
  }
  throw new Error("expected a failure");
}

const winstonMailbox = {
  provider: "winston" as const,
  externalEmail: "ada@runwinston.email",
  tokenCiphertext: null,
  scopes: [],
  capabilities: { read: true, draft: true, send: true, modify_labels: true },
};

describe("account resolution", () => {
  test("Winston's own mailbox is used only when it's named", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const winston = await insertConnection(tx, user.id, winstonMailbox);
      expect(
        await failure(() => resolveConnection(tx, user.id, "mail", undefined)),
      ).toEqual({
        code: "not_found",
        message:
          "The user has no connected mail account; ada@runwinston.email is Winston's own.",
        hint: "Name it with --account ada@runwinston.email, or the user can connect theirs at runwinston.com/accounts.",
      });
      const gmail = await insertConnection(tx, user.id, {
        externalEmail: "ada@gmail.com",
      });
      expect((await resolveConnection(tx, user.id, "mail", undefined)).id).toBe(
        gmail.id,
      );
      expect(
        (await resolveConnection(tx, user.id, "mail", "ada@runwinston.email"))
          .id,
      ).toBe(winston.id);
    });
  });

  test("Winston's mailbox may do everything while it's on, and says how to turn it on when it's off", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const winston = await insertConnection(tx, user.id, winstonMailbox);
      expect(() => {
        requireCapability(winston, "send", web);
      }).not.toThrow();
      expect(
        await failure(() => {
          requireCapability(
            { ...winston, status: "disconnected" },
            "read",
            web,
          );
        }),
      ).toEqual({
        code: "permission_disabled",
        message: "Winston's email address ada@runwinston.email is turned off.",
        hint: "The user can turn it on at https://runwinston.com/channels",
      });
    });
  });

  test("with one account for the domain, it's used without --account", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const mail = await insertConnection(tx, user.id, {
        externalEmail: "me@example.com",
      });
      await insertConnection(tx, user.id, { domain: "calendar" });
      expect((await resolveConnection(tx, user.id, "mail", undefined)).id).toBe(
        mail.id,
      );
    });
  });

  test("with several, --account picks by address or acct_ id, and its absence lists the choices", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const work = await insertConnection(tx, user.id, {
        externalEmail: "work@acme.com",
      });
      const home = await insertConnection(tx, user.id, {
        externalEmail: "me@gmail.com",
      });
      expect(
        (await resolveConnection(tx, user.id, "mail", "Work@Acme.com")).id,
      ).toBe(work.id);
      expect((await resolveConnection(tx, user.id, "mail", home.id)).id).toBe(
        home.id,
      );
      expect(
        await failure(() => resolveConnection(tx, user.id, "mail", undefined)),
      ).toEqual({
        code: "invalid_request",
        message: "There are 2 mail accounts: me@gmail.com, work@acme.com.",
        hint: "Say which with --account <email>.",
      });
      expect(
        await failure(() =>
          resolveConnection(tx, user.id, "mail", "nope@x.com"),
        ),
      ).toMatchObject({
        code: "not_found",
        hint: "Use one of: me@gmail.com, work@acme.com.",
      });
    });
  });

  test("no account, or only a disconnected one, is not_found pointing at the site", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      await insertConnection(tx, user.id, { status: "disconnected" });
      expect(
        await failure(() => resolveConnection(tx, user.id, "mail", undefined)),
      ).toEqual({
        code: "not_found",
        message: "There's no connected mail account.",
        hint: "The user can connect one at runwinston.com/accounts.",
      });
    });
  });

  test("someone else's account is never found", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const other = await insertUser(tx);
      const theirs = await insertConnection(tx, other.id);
      await insertConnection(tx, user.id);
      expect(
        (await failure(() => resolveConnection(tx, user.id, "mail", theirs.id)))
          .code,
      ).toBe("not_found");
    });
  });
});

describe("permission enforcement", () => {
  test("a capability switched off is permission_disabled, linking to the toggle", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const connection = await insertConnection(tx, user.id, {
        externalEmail: "me@example.com",
        scopes: ["gmail.modify"],
        capabilities: { read: true, send: false },
      });
      expect(() => {
        requireCapability(connection, "read", web);
      }).not.toThrow();
      expect(
        await failure(() => {
          requireCapability(connection, "send", web);
        }),
      ).toEqual({
        code: "permission_disabled",
        message: "Sending is turned off for me@example.com.",
        hint: `The user can turn it on at https://runwinston.com/accounts?account=${connection.id}`,
      });
    });
  });

  test("an expired grant is auth_expired with the one-tap reconnect link", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const connection = await insertConnection(tx, user.id, {
        status: "expired",
        scopes: ["gmail.modify"],
      });
      expect(
        await failure(() => {
          requireCapability(connection, "read", web);
        }),
      ).toMatchObject({
        code: "auth_expired",
        hint: `The user can reconnect it with one tap: https://runwinston.com/auth/google/connect?reconnect=${connection.id}`,
      });
    });
  });

  test("a scope Google wasn't granted makes its capability unusable until reconnecting, even if switched on", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const connection = await insertConnection(tx, user.id, {
        domain: "calendar",
        scopes: [],
      });
      expect(
        await failure(() => {
          requireCapability(connection, "create", web);
        }),
      ).toMatchObject({
        code: "permission_disabled",
        message: expect.stringContaining(
          "wasn't granted creating events",
        ) as unknown,
      });
    });
  });
});

describe("connector failures", () => {
  test("become the API's codes", () => {
    expect(
      toApiFailure(new NotSupportedError("No labels here", "Use folders"), web),
    ).toMatchObject({
      code: "not_supported",
      message: "No labels here",
      hint: "Use folders",
    });
    expect(
      toApiFailure(new ProviderNotFoundError("No such message"), web)?.code,
    ).toBe("not_found");
    expect(
      toApiFailure(new ConnectionUnavailableError("acct_1", "expired"), web)
        ?.hint,
    ).toContain("reconnect=acct_1");
    expect(toApiFailure(new Error("boom"), web)).toBeUndefined();
  });
});
