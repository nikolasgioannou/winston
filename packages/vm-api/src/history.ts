/**
 * `winston history` (docs/design.md §2 Message archive, §11): Winston's own
 * search over what scrolled out of the window: the user's messages, his
 * replies, events, task reports, and what he did in connected apps. Postgres
 * full-text search, no embeddings: agents rephrase and retry, and keywords
 * are exact on names, emails and order numbers. Every result is rendered as
 * the envelope it is (or would be) in the context window, with its `hist_` id.
 */
import type { DbOrTx } from "@winston/db/client";
import { toEnvelopeItems } from "@winston/db/envelopes";
import {
  auditLog,
  inboundItems,
  outboundMessages,
  users,
} from "@winston/db/schema";
import {
  renderAction,
  renderBatch,
  renderSentMessage,
} from "@winston/domain/envelope";
import { parseTimeFlag } from "@winston/shared/time-flag";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import { validator } from "hono/validator";
import { z } from "zod";
import { ApiFailure } from "./connections.ts";
import type { VmApiEnv } from "./env.ts";

export const historyKinds = ["message", "event", "task", "action"] as const;
export type HistoryKind = (typeof historyKinds)[number];

const searchQuery = z.object({
  text: z.string().max(500).optional(),
  type: z.enum(historyKinds).optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
  cursor: z.string().optional(),
});

const getQuery = z.object({
  context: z.coerce.number().int().min(0).max(20).default(0),
});

interface Row {
  id: string;
  kind: HistoryKind;
  at: Date;
}

/** Everything in a user's history as one timeline: id, kind and time, with a rank when searching. */
function timeline(userId: string, query: SQL | undefined, alias = "history") {
  const match = (tsv: SQL) => (query ? sql`and ${tsv} @@ ${query}` : sql``);
  const rank = (tsv: SQL) =>
    query ? sql`ts_rank(${tsv}, ${query})` : sql`0::real`;
  return sql`(
    select ${inboundItems.id} as id,
      case when ${inboundItems.type} = 'user_message' then 'message'
           when ${inboundItems.type} like 'task.%' then 'task'
           else 'event' end as kind,
      ${inboundItems.occurredAt} as at, ${rank(sql`${inboundItems.tsv}`)} as rank
    from ${inboundItems}
    where ${inboundItems.userId} = ${userId} and not ${inboundItems.pending} ${match(sql`${inboundItems.tsv}`)}
    union all
    select ${outboundMessages.id}, 'message', ${outboundMessages.sentAt}, ${rank(sql`${outboundMessages.tsv}`)}
    from ${outboundMessages}
    where ${outboundMessages.userId} = ${userId} ${match(sql`${outboundMessages.tsv}`)}
    union all
    select ${auditLog.historyId}, 'action', ${auditLog.createdAt}, ${rank(sql`${auditLog.tsv}`)}
    from ${auditLog}
    where ${auditLog.userId} = ${userId} ${match(sql`${auditLog.tsv}`)}
  ) as ${sql.identifier(alias)}`;
}

const toRows = (result: unknown) =>
  (result as { rows?: unknown[] }).rows ?? (result as unknown[]);

const asRow = (raw: Record<string, unknown>): Row => ({
  id: String(raw.id),
  kind: raw.kind as HistoryKind,
  at: raw.at instanceof Date ? raw.at : new Date(String(raw.at)),
});

/** Renders rows as their envelopes, in the order given. */
async function render(db: DbOrTx, userId: string, rows: Row[]) {
  const [user] = await db
    .select({ timezone: users.timezone })
    .from(users)
    .where(eq(users.id, userId));
  const timeZone = user?.timezone ?? "UTC";
  const ids = rows.map((row) => row.id);
  const envelopes = new Map<string, string>();
  if (ids.length > 0) {
    const inbound = await db
      .select()
      .from(inboundItems)
      .where(
        and(eq(inboundItems.userId, userId), inArray(inboundItems.id, ids)),
      );
    const items = await toEnvelopeItems(db, userId, inbound);
    inbound.forEach((row, i) => {
      const item = items[i];
      if (item) envelopes.set(row.id, renderBatch([item], timeZone));
    });
    for (const row of await db
      .select()
      .from(outboundMessages)
      .where(
        and(
          eq(outboundMessages.userId, userId),
          inArray(outboundMessages.id, ids),
        ),
      ))
      envelopes.set(row.id, renderSentMessage(row, timeZone));
    for (const row of await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.userId, userId), inArray(auditLog.historyId, ids)),
      ))
      envelopes.set(
        row.historyId,
        renderAction({ ...row, occurredAt: row.createdAt }, timeZone),
      );
  }
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    at: row.at.toISOString(),
    envelope: envelopes.get(row.id) ?? "",
  }));
}

export function historyRoutes({ db }: { db: DbOrTx }) {
  return new Hono<VmApiEnv>()
    .get(
      "/search",
      // Declares the query for the CLI's typed client; parsed below.
      validator(
        "query",
        (value) =>
          value as Partial<Record<keyof z.input<typeof searchQuery>, string>>,
      ),
      async (c) => {
        const query = searchQuery.safeParse(c.req.valid("query"));
        if (!query.success)
          throw new ApiFailure(
            "invalid_request",
            z.prettifyError(query.error),
            "Run winston history search --help.",
          );
        const { userId } = c.get("run");
        const [user] = await db
          .select({ timezone: users.timezone })
          .from(users)
          .where(eq(users.id, userId));
        const timeZone = user?.timezone ?? "UTC";
        const text = query.data.text?.trim();
        // English stems or the words as written, whichever matches.
        const tsquery = text
          ? sql`(websearch_to_tsquery('english'::regconfig, ${text}) || websearch_to_tsquery('simple'::regconfig, ${text}))`
          : undefined;
        const conditions: SQL[] = [];
        if (query.data.type) conditions.push(sql`kind = ${query.data.type}`);
        if (query.data.since)
          conditions.push(
            sql`at >= ${parseTimeFlag(query.data.since, { timeZone, direction: "past" }).toISOString()}::timestamptz`,
          );
        if (query.data.until)
          conditions.push(
            sql`at < ${parseTimeFlag(query.data.until, { timeZone, direction: "past" }).toISOString()}::timestamptz`,
          );
        const offset = query.data.cursor
          ? Number(Buffer.from(query.data.cursor, "base64url").toString())
          : 0;
        if (!Number.isInteger(offset) || offset < 0)
          throw new ApiFailure(
            "invalid_request",
            "That cursor isn't one history search gave.",
          );
        const limit = query.data.limit;
        const raw = toRows(
          await db.execute(sql`
          select id, kind, at from ${timeline(userId, tsquery)}
          ${conditions.length > 0 ? sql`where ${sql.join(conditions, sql` and `)}` : sql``}
          order by round(rank::numeric, 2) desc, at desc, id desc
          limit ${limit + 1} offset ${offset}`),
        ) as Record<string, unknown>[];
        const rows = raw.slice(0, limit).map(asRow);
        return c.json({
          items: await render(db, userId, rows),
          nextCursor:
            raw.length > limit
              ? Buffer.from(String(offset + limit)).toString("base64url")
              : null,
        });
      },
    )
    .get(
      "/:id",
      validator("query", (value) => value as { context?: string }),
      async (c) => {
        const query = getQuery.safeParse(c.req.valid("query"));
        if (!query.success)
          throw new ApiFailure("invalid_request", z.prettifyError(query.error));
        const { userId } = c.get("run");
        const id = c.req.param("id");
        const [found] = (
          toRows(
            await db.execute(
              sql`select id, kind, at from ${timeline(userId, undefined)} where id = ${id}`,
            ),
          ) as Record<string, unknown>[]
        ).map(asRow);
        if (!found)
          throw new ApiFailure(
            "not_found",
            `There's no history item ${id}.`,
            "History ids look like hist_…; find them with winston history search.",
          );
        const n = query.data.context;
        const around = async (before: boolean) =>
          n === 0
            ? []
            : (
                toRows(
                  await db.execute(sql`
                  select id, kind, at from ${timeline(userId, undefined)}
                  where (at, id) ${before ? sql`<` : sql`>`} (select item.at, item.id from ${timeline(userId, undefined, "item")} where item.id = ${found.id})
                  order by at ${before ? sql`desc` : sql`asc`}, id ${before ? sql`desc` : sql`asc`}
                  limit ${n}`),
                ) as Record<string, unknown>[]
              ).map(asRow);
        const before = (await around(true)).reverse();
        const after = await around(false);
        return c.json({
          id: found.id,
          items: await render(db, userId, [...before, found, ...after]),
        });
      },
    );
}
