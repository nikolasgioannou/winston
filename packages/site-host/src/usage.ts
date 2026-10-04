import type { DbOrTx } from "@winston/db/client";
import { costLedger, sites } from "@winston/db/schema";
import { recordSystemEvent } from "@winston/db/system-events";
import { and, eq, gte, isNotNull, sql, sum } from "drizzle-orm";
import type { SiteHost } from "./host.ts";
import { routeOf, type Site } from "./manage.ts";

/**
 * Sites' guardrails (docs/design.md §9a): usage counted every hour, charged
 * to the cost ledger, and caps that pause a site rather than run up a bill.
 */

/** Per site, per month. */
export const siteRequestCap = 1_000_000;
/** Per database. */
export const databaseByteCap = 500 * 1024 * 1024;
/** Per user, per month: their sites' hosting charges. */
export const monthlyHostingCapUsd = 10;

/**
 * What a site's usage costs: Workers for Platforms' prices past what the plan
 * includes, so each user's share of what they use (the plan's monthly fee
 * isn't split between users).
 */
export const hostingPrices = { perRequest: 0.3 / 1e6, perCpuMs: 0.02 / 1e6 };

export const siteUsageEveryMs = 60 * 60_000;

export type PauseReason = NonNullable<Site["pausedReason"]>;

/** `2026-10`: the month a time is in, in UTC. */
const monthOf = (at: Date) => at.toISOString().slice(0, 7);
const startOfMonth = (at: Date) =>
  new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
const startOfNextMonth = (at: Date) =>
  new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));

/** Pauses reset at the start of each month; the others don't. */
const resumesWithTheMonth = (reason: PauseReason) =>
  reason === "requests" || reason === "spend";

/**
 * Pauses a site: its route says so, so visitors get the paused page, and
 * Winston hears of it once per site, month and reason.
 */
export async function pauseSite(
  db: DbOrTx,
  host: SiteHost,
  site: Site,
  reason: PauseReason,
  now = new Date(),
) {
  const [paused] = await db
    .update(sites)
    .set({ paused: true, pausedReason: reason })
    .where(eq(sites.id, site.id))
    .returning();
  if (!paused) return;
  await host.setRoute(paused.name, routeOf(paused));
  await recordSystemEvent(db, {
    userId: paused.userId,
    type: "system.site.paused",
    payload: {
      siteId: paused.id,
      name: paused.name,
      reason,
      resumesAt: resumesWithTheMonth(reason)
        ? startOfNextMonth(now).toISOString()
        : null,
    },
    sourceRef: `site.paused:${paused.id}:${monthOf(now)}:${reason}`,
  });
}

export async function resumeSite(db: DbOrTx, host: SiteHost, site: Site) {
  const [resumed] = await db
    .update(sites)
    .set({ paused: false, pausedReason: null })
    .where(eq(sites.id, site.id))
    .returning();
  if (resumed) await host.setRoute(resumed.name, routeOf(resumed));
}

/**
 * Counts every deployed site's usage since it was last counted, charges it,
 * and applies the caps. Each site is handled under its row lock, so two
 * agents tasks (a deploy) never count the same hour twice.
 */
export async function accrueSiteUsage(
  db: DbOrTx,
  host: SiteHost,
  now = new Date(),
) {
  const month = monthOf(now);
  const deployed = await db
    .select({ id: sites.id })
    .from(sites)
    .where(isNotNull(sites.currentVersion));
  const users = new Set<string>();
  for (const { id } of deployed)
    await db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(sites)
        .where(eq(sites.id, id))
        .for("update");
      if (!locked) return;
      let site = locked;
      users.add(site.userId);
      // A new month: fresh counters, and month-long pauses lifted.
      if (site.usageMonth !== month) {
        const [reset] = await tx
          .update(sites)
          .set({ usageMonth: month, monthRequests: 0, monthCpuMs: 0 })
          .where(eq(sites.id, site.id))
          .returning();
        site = reset ?? site;
        if (site.pausedReason && resumesWithTheMonth(site.pausedReason)) {
          await resumeSite(tx, host, site);
          site = { ...site, paused: false, pausedReason: null };
        }
      }
      const from = site.usageAccruedAt ?? site.createdAt;
      if (from >= now) return;
      const used = await host.usage(site.id, from, now);
      const [counted] = await tx
        .update(sites)
        .set({
          monthRequests: site.monthRequests + used.requests,
          monthCpuMs: site.monthCpuMs + used.cpuMs,
          usageAccruedAt: sql`${now.toISOString()}::timestamptz`,
        })
        .where(eq(sites.id, site.id))
        .returning();
      site = counted ?? site;
      // The ledger keeps micro-dollars: an hour that rounds to nothing isn't a charge.
      const cost = (
        used.requests * hostingPrices.perRequest +
        used.cpuMs * hostingPrices.perCpuMs
      ).toFixed(6);
      if (Number(cost) > 0)
        await tx.insert(costLedger).values({
          userId: site.userId,
          category: "hosting",
          costUsd: cost,
          occurredAt: now,
        });

      const oversized = site.databaseId
        ? (await host.databaseSize(site.databaseId)) > databaseByteCap
        : false;
      if (site.pausedReason === "database" && !oversized)
        await resumeSite(tx, host, site);
      else if (!site.paused && site.monthRequests > siteRequestCap)
        await pauseSite(tx, host, site, "requests", now);
      else if (!site.paused && oversized)
        await pauseSite(tx, host, site, "database", now);
    });

  // Over their monthly spend: every one of the user's sites pauses.
  for (const userId of users) {
    const [spent] = await db
      .select({ usd: sum(costLedger.costUsd) })
      .from(costLedger)
      .where(
        and(
          eq(costLedger.userId, userId),
          eq(costLedger.category, "hosting"),
          gte(costLedger.occurredAt, startOfMonth(now)),
        ),
      );
    if (Number(spent?.usd ?? 0) <= monthlyHostingCapUsd) continue;
    const running = await db
      .select()
      .from(sites)
      .where(
        and(
          eq(sites.userId, userId),
          eq(sites.paused, false),
          isNotNull(sites.currentVersion),
        ),
      );
    for (const site of running) await pauseSite(db, host, site, "spend", now);
  }
}

/** The kill switch: pauses every running site at once. Returns how many. */
export async function pauseAllSites(db: DbOrTx, host: SiteHost) {
  const running = await db
    .select()
    .from(sites)
    .where(and(eq(sites.paused, false), isNotNull(sites.currentVersion)));
  for (const site of running) await pauseSite(db, host, site, "kill_switch");
  return running.length;
}

/** Undoes the kill switch, leaving sites paused for other reasons. Returns how many. */
export async function resumeAllSites(db: DbOrTx, host: SiteHost) {
  const switchedOff = await db
    .select()
    .from(sites)
    .where(eq(sites.pausedReason, "kill_switch"));
  for (const site of switchedOff) await resumeSite(db, host, site);
  return switchedOff.length;
}
