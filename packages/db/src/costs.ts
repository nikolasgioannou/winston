/**
 * Spend from `cost_ledger` (docs/design.md §8, Cost tracking), for
 * `bun run costs` and `bun run prod costs`: by category, model spend by
 * agent kind and by what started the run, and the most expensive runs. No
 * UI: this is the view that says whether event runs, the browser or the
 * front of house dominate cost.
 */
import { and, desc, eq, gte, lt, sql, sum, type SQL } from "drizzle-orm";
import type { DbOrTx } from "./client.ts";
import { costLedger, runs, users } from "./schema/index.ts";

export interface CostReport {
  from: Date;
  to: Date;
  total: number;
  byCategory: { category: string; usd: number }[];
  /** Model spend by agent kind: the front of house, or background runs. */
  modelByKind: { kind: string; usd: number }[];
  /** Model spend by what started the run: the user, a delegation, an event, a schedule… */
  modelByTrigger: { trigger: string; usd: number }[];
  topRuns: { runId: string; kind: string; brief: string; usd: number }[];
}

/** The calendar month `YYYY-MM` in UTC, or this one. */
export function monthRange(month?: string, now = new Date()) {
  const match = month ? /^(\d{4})-(\d{2})$/.exec(month) : undefined;
  if (month && !match)
    throw new Error(`"${month}" isn't a month like 2026-10.`);
  const year = match ? Number(match[1]) : now.getUTCFullYear();
  const index = match ? Number(match[2]) - 1 : now.getUTCMonth();
  return {
    from: new Date(Date.UTC(year, index, 1)),
    to: new Date(Date.UTC(year, index + 1, 1)),
  };
}

const usd = (value: string | null) => Number(value ?? 0);

export async function costReport(
  db: DbOrTx,
  { userId, from, to }: { userId?: string | undefined; from: Date; to: Date },
): Promise<CostReport> {
  const within: SQL[] = [
    gte(costLedger.occurredAt, from),
    lt(costLedger.occurredAt, to),
  ];
  if (userId) within.push(eq(costLedger.userId, userId));
  const where = and(...within);
  const model = and(where, eq(costLedger.category, "model"));
  const amount = sum(costLedger.costUsd);

  const byCategory = await db
    .select({ category: costLedger.category, usd: amount })
    .from(costLedger)
    .where(where)
    .groupBy(costLedger.category)
    .orderBy(desc(amount));
  const modelByKind = await db
    .select({
      kind: sql<string>`coalesce(${runs.kind}::text, 'none')`,
      usd: amount,
    })
    .from(costLedger)
    .leftJoin(runs, eq(runs.id, costLedger.runId))
    .where(model)
    .groupBy(sql`1`)
    .orderBy(desc(amount));
  // A front-of-house turn answers the user; background runs say what started them.
  const trigger = sql<string>`case when ${runs.kind} = 'front' then 'user' else coalesce(${runs.triggerType}::text, 'manual') end`;
  const modelByTrigger = await db
    .select({ trigger, usd: amount })
    .from(costLedger)
    .leftJoin(runs, eq(runs.id, costLedger.runId))
    .where(and(model, sql`${costLedger.runId} is not null`))
    .groupBy(sql`1`)
    .orderBy(desc(amount));
  const topRuns = await db
    .select({
      runId: runs.id,
      kind: runs.kind,
      brief: sql<string>`coalesce(${runs.brief}, '')`,
      usd: amount,
    })
    .from(costLedger)
    .innerJoin(runs, eq(runs.id, costLedger.runId))
    .where(where)
    .groupBy(runs.id)
    .orderBy(desc(amount))
    .limit(10);

  const categories = byCategory.map((row) => ({
    category: row.category,
    usd: usd(row.usd),
  }));
  return {
    from,
    to,
    total: categories.reduce((total, row) => total + row.usd, 0),
    byCategory: categories,
    modelByKind: modelByKind.map((row) => ({
      kind: row.kind,
      usd: usd(row.usd),
    })),
    modelByTrigger: modelByTrigger.map((row) => ({
      trigger: row.trigger,
      usd: usd(row.usd),
    })),
    topRuns: topRuns.map((row) => ({ ...row, usd: usd(row.usd) })),
  };
}

const money = (value: number) => `$${value.toFixed(2)}`;

/** The report as text. */
export function formatCostReport(report: CostReport, who: string) {
  const month = report.from.toISOString().slice(0, 7);
  const rows = (pairs: [string, number][]) =>
    pairs.length === 0
      ? ["  (nothing)"]
      : pairs.map(([label, value]) => `  ${label.padEnd(12)} ${money(value)}`);
  const firstLine = (brief: string) => {
    const line =
      brief
        .split("\n")
        .find((l) => l.trim())
        ?.trim() ?? "";
    return line.length > 80 ? `${line.slice(0, 80)}…` : line;
  };
  return [
    `Spend for ${who}, ${month}: ${money(report.total)}`,
    "",
    "By category:",
    ...rows(report.byCategory.map((r) => [r.category, r.usd])),
    "",
    "Model spend by agent:",
    ...rows(report.modelByKind.map((r) => [r.kind, r.usd])),
    "",
    "Model spend by what started the run:",
    ...rows(report.modelByTrigger.map((r) => [r.trigger, r.usd])),
    "",
    "Most expensive runs:",
    ...(report.topRuns.length === 0
      ? ["  (none)"]
      : report.topRuns.map(
          (r) =>
            `  ${money(r.usd).padStart(8)}  ${r.runId}  ${r.kind}  ${r.kind === "front" ? "(a front-of-house turn)" : firstLine(r.brief)}`,
        )),
  ].join("\n");
}

/** `costs [--user <email>] [--month YYYY-MM]`, for the local script and `prod costs`. */
export async function costsCommand(db: DbOrTx, args: string[]) {
  const flag = (name: string) => {
    const at = args.indexOf(`--${name}`);
    return at === -1 ? undefined : args[at + 1];
  };
  const email = flag("user");
  let userId: string | undefined;
  if (email) {
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email.trim().toLowerCase()));
    if (!user) {
      console.log(`There's no user ${email}.`);
      return 1;
    }
    userId = user.id;
  }
  let range;
  try {
    range = monthRange(flag("month"));
  } catch (error) {
    console.log(error instanceof Error ? error.message : String(error));
    return 1;
  }
  const report = await costReport(db, { userId, ...range });
  console.log(formatCostReport(report, email ?? "everyone"));
  return 0;
}
