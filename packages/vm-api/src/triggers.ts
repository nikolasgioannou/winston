/**
 * `winston trigger` (docs/design.md §3, §11): the schedules and subscriptions
 * Winston sets for himself. Validation is strict and says exactly what's
 * wrong, because a trigger that's silently wrong is proactivity that
 * silently fails. Users never see triggers.
 */
import type { DbOrTx } from "@winston/db/client";
import { resolveRef } from "@winston/db/external-refs";
import { enqueue } from "@winston/db/queue";
import {
  connections,
  derivedTimers,
  triggers,
  users,
} from "@winston/db/schema";
import { refreshTimersJob } from "@winston/domain/jobs";
import {
  eventDefinition,
  filterFields,
  type FilterField,
} from "@winston/domain/events";
import { cronProblem, nextFireAt } from "@winston/domain/triggers";
import { parseTimeFlag } from "@winston/shared/time-flag";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { Hono } from "hono";
import { validator } from "hono/validator";
import { z } from "zod";
import { ApiFailure, resolveConnection } from "./connections.ts";
import type { VmApiEnv } from "./env.ts";

const fields = {
  at: z.string().min(1).optional(),
  cron: z.string().min(1).optional(),
  on: z.string().min(1).optional(),
  filter: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional(),
  native: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  /** Minutes before, for `calendar.event.starting`. */
  lead: z
    .number()
    .int()
    .min(1)
    .max(14 * 24 * 60)
    .optional(),
  account: z.string().min(1).optional(),
  maxFires: z.number().int().min(1).optional(),
  expires: z.string().min(1).optional(),
  onExpire: z.string().trim().min(1).optional(),
};

const createBody = z.object({ ...fields, note: z.string().trim().min(1) });
const updateBody = z.object({
  ...fields,
  note: z.string().trim().min(1).optional(),
});

const body = <T extends z.ZodType>(schema: T, hint: string) =>
  validator("json", (value) => {
    const parsed = schema.safeParse(value);
    if (!parsed.success)
      throw new ApiFailure(
        "invalid_request",
        z.prettifyError(parsed.error),
        hint,
      );
    return parsed.data;
  });

type Row = typeof triggers.$inferSelect;
type Input = z.output<typeof updateBody>;

const invalid = (message: string, hint?: string) =>
  new ApiFailure("invalid_request", message, hint ?? null);

export function triggerRoutes({ db }: { db: DbOrTx }) {
  const timeZoneOf = async (userId: string) =>
    (
      await db
        .select({ timeZone: users.timezone })
        .from(users)
        .where(eq(users.id, userId))
    )[0]?.timeZone ?? "UTC";

  /** A time flag, resolved ahead in the user's zone; it must be in the future. */
  const future = (flag: string, input: string, timeZone: string) => {
    const date = parseTimeFlag(input, { timeZone, direction: "future" });
    if (date <= new Date()) throw invalid(`--${flag} ${input} is in the past.`);
    return date;
  };

  /**
   * The row a create or update would write, with every rule checked: one of
   * --at/--cron/--on, filters and scope that suit the event, --lead only where
   * it means something, the account's domain.
   */
  async function check(
    userId: string,
    input: Input & { note: string },
    timeZone: string,
    current?: Row,
  ) {
    const kinds = [input.at, input.cron, input.on].filter(
      (value) => value !== undefined,
    );
    if (kinds.length !== 1)
      throw invalid(
        'Say what wakes you: exactly one of --at <time>, --cron "<5-field cron>" or --on <event-type>.',
      );
    const now = new Date();
    const expiresAt =
      input.expires === undefined
        ? (current?.expiresAt ?? null)
        : future("expires", input.expires, timeZone);
    const onExpireNote = input.onExpire ?? current?.onExpireNote ?? null;
    if (onExpireNote !== null && expiresAt === null)
      throw invalid("--on-expire needs --expires: when should it notice?");
    const common = {
      note: input.note,
      maxFires: input.maxFires ?? current?.maxFires ?? null,
      expiresAt,
      onExpireNote,
    };

    if (input.on === undefined) {
      // A schedule: no subscription flags.
      for (const [flag, value] of [
        ["native", input.native],
        ["scope", input.scope],
        ["lead", input.lead],
        ["account", input.account],
      ] as const)
        if (value !== undefined)
          throw invalid(
            `--${flag} is for subscriptions (--on), not schedules.`,
          );
      if (input.filter && Object.keys(input.filter).length > 0)
        throw invalid(
          `--${Object.keys(input.filter)[0] ?? ""} is a filter for subscriptions (--on), not schedules.`,
        );
      if (input.cron !== undefined) {
        const problem = cronProblem(input.cron);
        if (problem) throw invalid(problem);
      }
      const at =
        input.at === undefined ? null : future("at", input.at, timeZone);
      const schedule = {
        kind: "schedule" as const,
        at,
        cron: input.cron?.trim() ?? null,
      };
      const next = nextFireAt(schedule, now, timeZone);
      if (expiresAt && at && expiresAt <= at)
        throw invalid("--expires is before --at, so it would never fire.");
      return {
        ...schedule,
        ...common,
        // A one-off fires once unless told otherwise.
        maxFires: common.maxFires ?? (at ? 1 : null),
        eventType: null,
        connectionId: null,
        scopeRef: null,
        filter: {},
        nativeQuery: null,
        leadMinutes: null,
        nextFireAt: next,
      };
    }

    const definition = eventDefinition(input.on);
    if (definition?.delivery !== "subscribable")
      throw invalid(
        definition
          ? `${input.on} is always delivered, so there's nothing to subscribe to.`
          : `There's no event ${input.on}.`,
        "winston events catalog lists the events you can subscribe to.",
      );
    const { domain } = definition;
    const filter = input.filter ?? (current?.filter as Input["filter"]) ?? {};
    for (const [name, value] of Object.entries(filter)) {
      if (!(definition.filters as readonly string[]).includes(name))
        throw invalid(
          `--${name} isn't a filter for ${input.on}.`,
          `See winston events catalog ${domain}.`,
        );
      const field: { value?: string; description: string; integer?: true } =
        filterFields[name as FilterField];
      const ok = field.integer
        ? Number.isInteger(value) && Number(value) > 0
        : field.value
          ? typeof value === "string" && value.trim() !== ""
          : value === true;
      if (!ok)
        throw invalid(
          field.value
            ? `--${name} needs a value: --${name} ${field.value}.`
            : `--${name} is a switch and takes no value.`,
        );
    }
    const nativeQuery = input.native ?? current?.nativeQuery ?? null;
    if (nativeQuery !== null && domain !== "mail")
      throw invalid(
        "--native is a mail search query (Gmail syntax); calendar and system events use the structured filters.",
      );
    const leadMinutes = input.lead ?? current?.leadMinutes ?? null;
    if (definition.lead && leadMinutes === null)
      throw invalid(
        `${input.on} needs --lead: how long before the event, like --lead 15m.`,
      );
    if (!definition.lead && leadMinutes !== null)
      throw invalid("--lead only applies to calendar.event.starting.");

    // The account it listens to: named, or the scope's, or every one of the domain.
    let connectionId = current?.connectionId ?? null;
    if (input.account !== undefined) {
      if (domain !== "mail" && domain !== "calendar")
        throw invalid(`--account doesn't apply to ${input.on}.`);
      const connection = await resolveConnection(
        db,
        userId,
        domain,
        input.account,
      );
      if (nativeQuery !== null && connection.provider === "winston")
        throw invalid(
          "--native is Gmail's search syntax; Winston's own mailbox has none.",
          "Use the structured filters, like --from or --subject.",
        );
      connectionId = connection.id;
    }
    const scopeRef = input.scope ?? current?.scopeRef ?? null;
    if (scopeRef !== null) {
      const wanted = "scope" in definition ? definition.scope : undefined;
      if (!wanted)
        throw invalid(
          `${input.on} can't be scoped to one object.`,
          "Scope mail.message.* to a thr_ and calendar.event.updated/cancelled/starting or calendar.rsvp.changed to an evt_.",
        );
      const ref = await resolveRef(db, userId, scopeRef);
      const kind = wanted === "thread" ? "thread" : "calendarEvent";
      if (ref?.kind !== kind)
        throw invalid(
          `--scope for ${input.on} must be a ${wanted === "thread" ? "thr_" : "evt_"} id you've seen, not ${scopeRef}.`,
        );
      if (connectionId !== null && ref.connectionId !== connectionId)
        throw invalid(
          `${scopeRef} belongs to a different account than --account.`,
        );
      connectionId = ref.connectionId;
    }
    return {
      kind: "subscription" as const,
      at: null,
      cron: null,
      ...common,
      eventType: input.on,
      connectionId,
      scopeRef,
      filter,
      nativeQuery,
      leadMinutes,
      nextFireAt: null,
    };
  }

  /** A trigger as the CLI sees it. */
  async function dto(row: Row) {
    const [account] = row.connectionId
      ? await db
          .select({ email: connections.externalEmail })
          .from(connections)
          .where(eq(connections.id, row.connectionId))
      : [];
    return {
      id: row.id,
      kind: row.kind,
      status: row.status,
      at: row.at?.toISOString() ?? null,
      cron: row.cron,
      on: row.eventType,
      account: account?.email ?? null,
      scope: row.scopeRef,
      filter: row.filter as Record<string, string | number | boolean>,
      native: row.nativeQuery,
      leadMinutes: row.leadMinutes,
      note: row.note,
      maxFires: row.maxFires,
      fireCount: row.fireCount,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      onExpire: row.onExpireNote,
      nextFireAt: row.nextFireAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** A meeting heads-up subscription's timers are worked out in the background (agents). */
  async function queueTimers(row: Row) {
    if (row.eventType !== "calendar.event.starting") return;
    await enqueue(db, refreshTimersJob.type, {
      userId: row.userId,
      payload: { triggerId: row.id },
      dedupeKey: refreshTimersJob.dedupeKey(row.id),
    });
  }

  async function owned(userId: string, id: string) {
    const [row] = await db
      .select()
      .from(triggers)
      .where(
        and(
          eq(triggers.id, id),
          eq(triggers.userId, userId),
          ne(triggers.status, "deleted"),
        ),
      );
    if (!row)
      throw new ApiFailure(
        "not_found",
        `There's no trigger ${id}.`,
        "winston trigger list --all shows them.",
      );
    return row;
  }

  return new Hono<VmApiEnv>()
    .post(
      "/",
      body(createBody, "Run winston trigger create --help for the flags."),
      async (c) => {
        const { userId } = c.get("run");
        const timeZone = await timeZoneOf(userId);
        const values = await check(userId, c.req.valid("json"), timeZone);
        const [row] = await db
          .insert(triggers)
          .values({ userId, ...values })
          .returning();
        if (!row) throw new Error("Creating a trigger returned no row.");
        await queueTimers(row);
        return c.json({ timeZone, trigger: await dto(row) });
      },
    )
    .get("/", async (c) => {
      const { userId } = c.get("run");
      const kind = c.req.query("kind");
      if (kind !== undefined && kind !== "schedule" && kind !== "subscription")
        throw invalid("--kind is schedule or subscription.");
      const all = c.req.query("all") === "true";
      const rows = await db
        .select()
        .from(triggers)
        .where(
          and(
            eq(triggers.userId, userId),
            all
              ? ne(triggers.status, "deleted")
              : eq(triggers.status, "active"),
            kind ? eq(triggers.kind, kind) : undefined,
          ),
        )
        .orderBy(desc(triggers.createdAt), desc(triggers.id))
        .limit(200);
      return c.json({
        timeZone: await timeZoneOf(userId),
        triggers: await Promise.all(rows.map(dto)),
      });
    })
    .get("/:id", async (c) => {
      const { userId } = c.get("run");
      const row = await owned(userId, c.req.param("id"));
      return c.json({
        timeZone: await timeZoneOf(userId),
        trigger: await dto(row),
      });
    })
    .patch(
      "/:id",
      body(updateBody, "Run winston trigger update --help for the flags."),
      async (c) => {
        const { userId } = c.get("run");
        const current = await owned(userId, c.req.param("id"));
        if (current.status !== "active")
          throw new ApiFailure(
            "conflict",
            `${current.id} has ended (${current.status}).`,
            "Create a new trigger instead.",
          );
        const input = c.req.valid("json");
        const timeZone = await timeZoneOf(userId);
        // What it is now, with the new flags on top.
        const kept: Input & { note: string } = {
          ...((input.at ?? input.cron ?? input.on)
            ? {}
            : current.kind === "subscription"
              ? { on: current.eventType ?? "" }
              : current.cron
                ? { cron: current.cron }
                : { at: current.at?.toISOString() ?? "" }),
          ...input,
          note: input.note ?? current.note,
        };
        if ((current.kind === "subscription") !== (kept.on !== undefined))
          throw invalid(
            `${current.id} is a ${current.kind}; delete it and create a ${current.kind === "schedule" ? "subscription" : "schedule"} instead.`,
          );
        const values = await check(userId, kept, timeZone, current);
        const [row] = await db
          .update(triggers)
          .set({ ...values, updatedAt: sql`now()` })
          .where(eq(triggers.id, current.id))
          .returning();
        if (!row) throw new Error("Updating a trigger returned no row.");
        await queueTimers(row);
        return c.json({ timeZone, trigger: await dto(row) });
      },
    )
    .delete("/:id", async (c) => {
      const { userId } = c.get("run");
      const row = await owned(userId, c.req.param("id"));
      await db
        .update(triggers)
        .set({ status: "deleted", updatedAt: sql`now()` })
        .where(eq(triggers.id, row.id));
      await db.delete(derivedTimers).where(eq(derivedTimers.triggerId, row.id));
      return c.json({ id: row.id, deleted: true as const });
    });
}
