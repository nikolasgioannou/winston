/**
 * The read side of `winston ramp` (02441f, docs/design.md §11): what's
 * waiting on the user, and their transactions, reimbursements, requests and
 * bills. Every route resolves `--account`, checks `read` on the server, and
 * names objects by typed ids (`txn_`, `rmb_`, `req_`, `bil_`).
 */
import type { RampObjectKind } from "@winston/connectors/ramp";
import type { DbOrTx } from "@winston/db/client";
import { refFor, refsFor, resolveRef } from "@winston/db/external-refs";
import { connections, users } from "@winston/db/schema";
import { parseTimeFlag } from "@winston/shared/time-flag";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import {
  ApiFailure,
  requireCapability,
  resolveConnection,
  type ConnectionRow,
  type ConnectorDeps,
} from "./connections.ts";
import type { VmApiEnv } from "./env.ts";

const flag = z.enum(["true", "false"]).transform((v) => v === "true");
const page = {
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
};
const spendQuery = z.object({
  account: z.string().optional(),
  scope: z.enum(["mine", "all", "awaiting_me"]).default("mine"),
  text: z.string().min(3).optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  ...page,
});
const transactionQuery = spendQuery.extend({
  state: z.enum(["pending", "cleared", "declined", "all"]).optional(),
  missing: flag.optional(),
});
const billQuery = z.object({
  account: z.string().optional(),
  text: z.string().min(3).optional(),
  unpaid: flag.optional(),
  ...page,
});
const accountQuery = z.object({ account: z.string().optional(), ...page });

/** Which CLI words a kind's ids go with, for "not found" hints. */
const commandOf: Record<RampObjectKind, string> = {
  rampTransaction: "winston ramp transactions",
  rampReimbursement: "winston ramp reimbursements",
  rampRequest: "winston ramp requests",
  rampBill: "winston ramp bills",
};

export function rampRoutes({
  db,
  connectors,
}: {
  db: DbOrTx;
  connectors: ConnectorDeps | undefined;
}) {
  const need = () => {
    const ramp = connectors?.ramp;
    if (!connectors || !ramp)
      throw new ApiFailure("unavailable", "Ramp isn't available here.");
    return { webPublicUrl: connectors.webPublicUrl, ramp };
  };

  const timeZoneOf = async (userId: string) =>
    (
      await db
        .select({ timeZone: users.timezone })
        .from(users)
        .where(eq(users.id, userId))
    )[0]?.timeZone ?? "UTC";

  /** A time flag as the calendar date Ramp filters by, in the user's zone. */
  const dateOf = (
    input: string | undefined,
    timeZone: string,
  ): string | undefined =>
    input === undefined
      ? undefined
      : Temporal.Instant.fromEpochMilliseconds(
          parseTimeFlag(input, { timeZone, direction: "past" }).getTime(),
        )
          .toZonedDateTimeISO(timeZone)
          .toPlainDate()
          .toString();

  function parse<T extends z.ZodType>(schema: T, query: unknown, verb: string) {
    const parsed = schema.safeParse(query);
    if (!parsed.success)
      throw new ApiFailure(
        "invalid_request",
        z.prettifyError(parsed.error),
        `Run winston ramp ${verb} --help for the flags.`,
      );
    return parsed.data;
  }

  async function connectionFor(userId: string, account: string | undefined) {
    const deps = need();
    const connection = await resolveConnection(db, userId, "ramp", account);
    requireCapability(connection, "read", deps.webPublicUrl);
    return { connection, provider: deps.ramp(connection) };
  }

  /** The connection and provider id an id stands for, if it's this kind. */
  async function lookUp(userId: string, id: string, kind: RampObjectKind) {
    const ref = await resolveRef(db, userId, id);
    const [connection] = ref
      ? await db
          .select()
          .from(connections)
          .where(
            and(
              eq(connections.id, ref.connectionId),
              eq(connections.userId, userId),
            ),
          )
      : [];
    if (ref?.kind !== kind || !connection)
      throw new ApiFailure(
        "not_found",
        `There's no ${id}.`,
        `Use an id from ${commandOf[kind]} list.`,
      );
    const deps = need();
    requireCapability(connection, "read", deps.webPublicUrl);
    return {
      connection,
      provider: deps.ramp(connection),
      providerId: ref.providerId,
    };
  }

  /** Replaces each item's provider id with its CLI id. */
  async function withIds<T extends { providerId: string }>(
    userId: string,
    connection: ConnectionRow,
    kind: RampObjectKind,
    items: T[],
  ) {
    const ids = await refsFor(
      db,
      userId,
      connection.id,
      kind,
      items.map((item) => item.providerId),
    );
    return items.map(({ providerId, ...rest }) => ({
      id: ids.get(providerId) ?? "",
      ...rest,
    }));
  }

  /** One item with its CLI id in place of the provider's. */
  async function withId<T extends { providerId: string }>(
    userId: string,
    connection: ConnectionRow,
    kind: RampObjectKind,
    { providerId, ...rest }: T,
  ) {
    return {
      id: await refFor(db, userId, connection.id, kind, providerId),
      ...rest,
    };
  }

  const account = (connection: ConnectionRow) => ({
    id: connection.id,
    email: connection.externalEmail,
  });

  /** Lists for one kind: a page from the provider, with CLI ids. */
  const listed = async <T extends { providerId: string }>(
    userId: string,
    connection: ConnectionRow,
    kind: RampObjectKind,
    result: { items: T[]; cursor: string | null },
  ) => ({
    account: account(connection),
    items: await withIds(userId, connection, kind, result.items),
    cursor: result.cursor,
  });

  return new Hono<VmApiEnv>()
    .get("/approvals", async (c) => {
      const query = parse(accountQuery, c.req.query(), "approvals list");
      const { userId } = c.get("run");
      const { connection, provider } = await connectionFor(
        userId,
        query.account,
      );
      const sections = await provider.attention();
      const objects = sections.flatMap((s) =>
        s.tasks.flatMap((t) => t.objects),
      );
      const ids = new Map<string, string>();
      for (const kind of new Set(objects.map((o) => o.kind))) {
        const refs = await refsFor(
          db,
          userId,
          connection.id,
          kind,
          objects.filter((o) => o.kind === kind).map((o) => o.providerId),
        );
        for (const [providerId, id] of refs)
          ids.set(`${kind}:${providerId}`, id);
      }
      return c.json({
        account: account(connection),
        sections: sections.map((s) => ({
          kind: s.kind,
          name: s.name,
          total: s.total,
          tasks: s.tasks.map((t) => ({
            kind: t.kind,
            summary: t.summary,
            ids: t.objects.flatMap((o) => {
              const id = ids.get(`${o.kind}:${o.providerId}`);
              return id ? [id] : [];
            }),
          })),
        })),
      });
    })
    .get("/transactions", async (c) => {
      const query = parse(transactionQuery, c.req.query(), "transactions list");
      const { userId } = c.get("run");
      const { connection, provider } = await connectionFor(
        userId,
        query.account,
      );
      const timeZone = await timeZoneOf(userId);
      const result = await provider.transactions(
        {
          scope: query.scope,
          text: query.text,
          since: dateOf(query.since, timeZone),
          until: dateOf(query.until, timeZone),
          state: query.state,
          missing: query.missing,
        },
        { limit: query.limit, cursor: query.cursor },
      );
      return c.json({
        timeZone,
        ...(await listed(userId, connection, "rampTransaction", result)),
      });
    })
    .get("/transactions/:id", async (c) => {
      const { userId } = c.get("run");
      const { connection, provider, providerId } = await lookUp(
        userId,
        c.req.param("id"),
        "rampTransaction",
      );
      const dto = await withId(
        userId,
        connection,
        "rampTransaction",
        await provider.transaction(providerId),
      );
      return c.json({
        account: account(connection),
        timeZone: await timeZoneOf(userId),
        transaction: dto,
      });
    })
    .get("/reimbursements", async (c) => {
      const query = parse(spendQuery, c.req.query(), "reimbursements list");
      const { userId } = c.get("run");
      const { connection, provider } = await connectionFor(
        userId,
        query.account,
      );
      const timeZone = await timeZoneOf(userId);
      const result = await provider.reimbursements(
        {
          scope: query.scope,
          text: query.text,
          since: dateOf(query.since, timeZone),
          until: dateOf(query.until, timeZone),
        },
        { limit: query.limit, cursor: query.cursor },
      );
      return c.json({
        timeZone,
        ...(await listed(userId, connection, "rampReimbursement", result)),
      });
    })
    .get("/reimbursements/:id", async (c) => {
      const { userId } = c.get("run");
      const { connection, provider, providerId } = await lookUp(
        userId,
        c.req.param("id"),
        "rampReimbursement",
      );
      const dto = await withId(
        userId,
        connection,
        "rampReimbursement",
        await provider.reimbursement(providerId),
      );
      return c.json({
        account: account(connection),
        timeZone: await timeZoneOf(userId),
        reimbursement: dto,
      });
    })
    .get("/requests", async (c) => {
      const query = parse(accountQuery, c.req.query(), "requests list");
      const { userId } = c.get("run");
      const { connection, provider } = await connectionFor(
        userId,
        query.account,
      );
      const result = await provider.requests({
        limit: query.limit,
        cursor: query.cursor,
      });
      return c.json(await listed(userId, connection, "rampRequest", result));
    })
    .get("/requests/:id", async (c) => {
      const { userId } = c.get("run");
      const { connection, provider, providerId } = await lookUp(
        userId,
        c.req.param("id"),
        "rampRequest",
      );
      const dto = await withId(
        userId,
        connection,
        "rampRequest",
        await provider.request(providerId),
      );
      return c.json({ account: account(connection), request: dto });
    })
    .get("/bills", async (c) => {
      const query = parse(billQuery, c.req.query(), "bills list");
      const { userId } = c.get("run");
      const { connection, provider } = await connectionFor(
        userId,
        query.account,
      );
      const result = await provider.bills(
        { text: query.text, unpaid: query.unpaid },
        { limit: query.limit, cursor: query.cursor },
      );
      return c.json(await listed(userId, connection, "rampBill", result));
    })
    .get("/bills/:id", async (c) => {
      const { userId } = c.get("run");
      const { connection, provider, providerId } = await lookUp(
        userId,
        c.req.param("id"),
        "rampBill",
      );
      const dto = await withId(
        userId,
        connection,
        "rampBill",
        await provider.bill(providerId),
      );
      return c.json({ account: account(connection), bill: dto });
    });
}
