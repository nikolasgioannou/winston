import type { BlobStore } from "@winston/blobs";
import type { DbOrTx } from "@winston/db/client";
import { sites, siteVersions } from "@winston/db/schema";
import { generateToken, hashToken } from "@winston/shared/tokens";
import { and, desc, eq, lt } from "drizzle-orm";
import { readBundle } from "./bundle.ts";
import type { SiteHost } from "./host.ts";
import { shareLink, siteUrl, type SiteRoute } from "./route.ts";

/**
 * Changing a deployed site (docs/design.md §9a): sharing, making it private,
 * rolling back. The VM-facing API (`winston site`) and the website's Sites
 * page both call these, so the two can't drift.
 */

export type Site = typeof sites.$inferSelect;

export interface ManageDeps {
  db: DbOrTx;
  host: SiteHost;
  blobs: BlobStore;
}

/** Each site keeps its newest versions' bundles, for rollback. */
export const keptVersions = 10;

/** Why a change can't be made, with what to do instead; callers map `kind` to their own errors. */
export class SiteChangeError extends Error {
  constructor(
    readonly kind: "conflict" | "not_found",
    message: string,
    readonly hint: string | null = null,
  ) {
    super(message);
  }
}

/** A site's entry in the routes map: the share key only as its hash. */
export const routeOf = (site: Site): SiteRoute => ({
  script: site.id,
  ownerId: site.userId,
  access: site.access,
  shareKeyHash:
    site.access === "link" && site.shareKey ? hashToken(site.shareKey) : null,
  paused: site.paused,
});

/** A site as the CLI and the Sites page see it: never its share key on its own, only inside the link. */
export const siteDto = (site: Site, sitesUrl: string) => ({
  id: site.id,
  name: site.name,
  url: siteUrl(sitesUrl, site.name),
  access: site.access,
  /** Opens the site for anyone, while it's shared by link. */
  shareLink:
    site.access === "link" && site.shareKey
      ? shareLink(sitesUrl, site.name, site.shareKey)
      : null,
  paused: site.paused,
  version: site.currentVersion,
  database: site.databaseId !== null,
  createdAt: site.createdAt.toISOString(),
  updatedAt: site.updatedAt.toISOString(),
});

export type SiteDto = ReturnType<typeof siteDto>;

/** Throws unless the site has a version to change. */
export function requireDeployed(site: Site) {
  if (site.currentVersion === null)
    throw new SiteChangeError(
      "conflict",
      `${site.name} hasn't been deployed yet.`,
      "Deploy it first with winston site deploy.",
    );
}

async function setAccess(
  { db, host }: ManageDeps,
  site: Site,
  changes: Pick<Site, "access" | "shareKey">,
) {
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(sites)
      .set({ ...changes, updatedAt: new Date() })
      .where(eq(sites.id, site.id))
      .returning();
    if (!updated) throw new Error("the site disappeared");
    await host.setRoute(updated.name, routeOf(updated));
    return updated;
  });
}

/** Shares a site by link. Already shared: the same link. Shared again after unsharing: a new one. */
export async function shareSite(deps: ManageDeps, site: Site) {
  requireDeployed(site);
  return site.access === "link" && site.shareKey
    ? site
    : setAccess(deps, site, { access: "link", shareKey: generateToken() });
}

/** Makes a site private again: its share link and anyone who opened it stop working. */
export async function unshareSite(deps: ManageDeps, site: Site) {
  requireDeployed(site);
  return setAccess(deps, site, { access: "private", shareKey: null });
}

/**
 * Puts an earlier version's files back (by default the newest before the
 * current) and makes it current, under the site's row lock. The database is
 * left as it is. With `dryRun`, finds the version without changing anything.
 */
export async function rollbackSite(
  { db, host, blobs }: ManageDeps,
  site: Site,
  { to, dryRun = false }: { to?: number | undefined; dryRun?: boolean } = {},
) {
  return db.transaction(async (tx) => {
    const [locked = site] = await tx
      .select()
      .from(sites)
      .where(eq(sites.id, site.id))
      .for("update");
    const current = locked.currentVersion;
    requireDeployed(locked);
    const [target] = await tx
      .select()
      .from(siteVersions)
      .where(
        and(
          eq(siteVersions.siteId, locked.id),
          to === undefined
            ? lt(siteVersions.number, current ?? 0)
            : eq(siteVersions.number, to),
        ),
      )
      .orderBy(desc(siteVersions.number))
      .limit(1);
    if (!target)
      throw new SiteChangeError(
        "not_found",
        to === undefined
          ? `${locked.name} has no version before ${String(current)} to go back to.`
          : `${locked.name} has no version ${String(to)} (only the last ${String(keptVersions)} are kept).`,
        "winston site versions lists them.",
      );
    if (target.number === current)
      throw new SiteChangeError(
        "conflict",
        `${locked.name} is already on version ${String(current)}.`,
      );
    if (dryRun) return { site: locked, from: current, to: target.number };
    const { script } = await readBundle(await blobs.get(target.bundleKey));
    await host.putScript(locked.id, {
      ...script,
      databaseId: locked.databaseId ?? undefined,
    });
    const [updated] = await tx
      .update(sites)
      .set({ currentVersion: target.number, updatedAt: new Date() })
      .where(eq(sites.id, locked.id))
      .returning();
    return { site: updated ?? locked, from: current, to: target.number };
  });
}

/** A site's kept versions, newest first. */
export async function versionsOf(db: DbOrTx, site: Site) {
  const rows = await db
    .select()
    .from(siteVersions)
    .where(eq(siteVersions.siteId, site.id))
    .orderBy(desc(siteVersions.number));
  return rows.map((row) => ({
    number: row.number,
    size: row.size,
    current: row.number === site.currentVersion,
    deployedAt: row.createdAt.toISOString(),
  }));
}
