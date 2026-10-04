import { describe, expect, test } from "bun:test";
import type { DbOrTx } from "@winston/db/client";
import { costLedger, inboundItems, sites } from "@winston/db/schema";
import { inRollback, insertUser, testDb } from "@winston/db/testing";
import { eq } from "drizzle-orm";
import type { SiteHost } from "./host.ts";
import type { SiteRoute } from "./route.ts";
import {
  accrueSiteUsage,
  databaseByteCap,
  monthlyHostingCapUsd,
  pauseAllSites,
  resumeAllSites,
  siteRequestCap,
} from "./usage.ts";

const db = await testDb();

/** A host whose sites report the usage and database sizes the test sets. */
function fakeHost() {
  const requests = new Map<string, number>();
  const cpuMs = new Map<string, number>();
  const sizes = new Map<string, number>();
  const routes = new Map<string, SiteRoute | null>();
  const host: SiteHost = {
    kind: "local",
    putScript: () => Promise.resolve(),
    deleteScript: () => Promise.resolve(),
    setRoute: (name, route) => {
      routes.set(name, route);
      return Promise.resolve();
    },
    createDatabase: () => Promise.resolve("unused"),
    deleteDatabase: () => Promise.resolve(),
    batchSql: () => Promise.resolve([]),
    // Each count is used up, as if it fell in the window asked about.
    usage: (script) => {
      const used = {
        requests: requests.get(script) ?? 0,
        cpuMs: cpuMs.get(script) ?? 0,
      };
      requests.delete(script);
      cpuMs.delete(script);
      return Promise.resolve(used);
    },
    databaseSize: (id) => Promise.resolve(sizes.get(id) ?? 0),
  };
  return { host, requests, cpuMs, sizes, routes };
}

async function deployedSite(
  tx: DbOrTx,
  userId: string,
  name: string,
  values: Partial<typeof sites.$inferInsert> = {},
) {
  const [site] = await tx
    .insert(sites)
    .values({ userId, name, currentVersion: 1, ...values })
    .returning();
  if (!site) throw new Error("no site");
  return site;
}

const siteRow = async (tx: DbOrTx, id: string) =>
  (await tx.select().from(sites).where(eq(sites.id, id)))[0];

const pausedEvents = (tx: DbOrTx, userId: string) =>
  tx
    .select({ payload: inboundItems.payload })
    .from(inboundItems)
    .where(eq(inboundItems.userId, userId));

describe("site usage", () => {
  test("counts requests and CPU time into the month and charges them to the ledger", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const site = await deployedSite(tx, user.id, "blog");
      const { host, requests, cpuMs } = fakeHost();
      requests.set(site.id, 2_000_000);
      cpuMs.set(site.id, 5_000_000);
      // Over the request cap: it'll pause, which is the next test's business.
      await accrueSiteUsage(tx, host, new Date("2026-10-04T12:00:00Z"));
      const counted = await siteRow(tx, site.id);
      expect(counted).toMatchObject({
        usageMonth: "2026-10",
        monthRequests: 2_000_000,
        monthCpuMs: 5_000_000,
      });
      const [charge] = await tx
        .select()
        .from(costLedger)
        .where(eq(costLedger.userId, user.id));
      // 2M requests at $0.30/M plus 5M CPU-ms at $0.02/M.
      expect(charge).toMatchObject({
        category: "hosting",
        costUsd: "0.700000",
      });
    });
  });

  test("a site over its monthly requests pauses once, tells Winston, and comes back next month", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const site = await deployedSite(tx, user.id, "busy");
      const { host, requests, routes } = fakeHost();
      requests.set(site.id, siteRequestCap + 1);
      await accrueSiteUsage(tx, host, new Date("2026-10-04T12:00:00Z"));
      expect(await siteRow(tx, site.id)).toMatchObject({
        paused: true,
        pausedReason: "requests",
      });
      expect(routes.get("busy")?.paused).toBe(true);
      await accrueSiteUsage(tx, host, new Date("2026-10-04T13:00:00Z"));
      const events = await pausedEvents(tx, user.id);
      expect(events).toEqual([
        {
          payload: {
            siteId: site.id,
            name: "busy",
            reason: "requests",
            resumesAt: "2026-11-01T00:00:00.000Z",
          },
        },
      ]);

      await accrueSiteUsage(tx, host, new Date("2026-11-01T01:00:00Z"));
      expect(await siteRow(tx, site.id)).toMatchObject({
        paused: false,
        pausedReason: null,
        usageMonth: "2026-11",
        monthRequests: 0,
      });
      expect(routes.get("busy")?.paused).toBe(false);
    });
  });

  test("a database over its size cap pauses until it's back under", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const site = await deployedSite(tx, user.id, "big", {
        databaseId: "db-1",
      });
      const { host, sizes } = fakeHost();
      sizes.set("db-1", databaseByteCap + 1);
      await accrueSiteUsage(tx, host, new Date("2026-10-04T12:00:00Z"));
      expect((await siteRow(tx, site.id))?.pausedReason).toBe("database");
      sizes.set("db-1", databaseByteCap - 1);
      await accrueSiteUsage(tx, host, new Date("2026-10-04T13:00:00Z"));
      expect((await siteRow(tx, site.id))?.paused).toBe(false);
    });
  });

  test("a user over their monthly hosting spend has every site paused", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const one = await deployedSite(tx, user.id, "one");
      const two = await deployedSite(tx, user.id, "two");
      await tx.insert(costLedger).values({
        userId: user.id,
        category: "hosting",
        costUsd: String(monthlyHostingCapUsd + 1),
        occurredAt: new Date("2026-10-02T00:00:00Z"),
      });
      const { host } = fakeHost();
      await accrueSiteUsage(tx, host, new Date("2026-10-04T12:00:00Z"));
      for (const site of [one, two])
        expect((await siteRow(tx, site.id))?.pausedReason).toBe("spend");
    });
  });

  test("the kill switch pauses every running site, and resuming leaves cap pauses alone", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const running = await deployedSite(tx, user.id, "running");
      const capped = await deployedSite(tx, user.id, "capped", {
        paused: true,
        pausedReason: "requests",
      });
      const { host } = fakeHost();
      expect(await pauseAllSites(tx, host)).toBe(1);
      expect((await siteRow(tx, running.id))?.pausedReason).toBe("kill_switch");
      expect(await resumeAllSites(tx, host)).toBe(1);
      expect((await siteRow(tx, running.id))?.paused).toBe(false);
      expect((await siteRow(tx, capped.id))?.pausedReason).toBe("requests");
    });
  });
});
