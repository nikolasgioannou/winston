/**
 * `winston site` (docs/design.md §9a, §11): deploying the sites Winston
 * builds to `<name>.runwinston.app`, and listing them. The CLI packs a site's
 * folder into a tar under the home folder; this reads it off the VM, keeps it
 * as a version, applies the site's migrations, and uploads it.
 */
import type { BlobStore } from "@winston/blobs";
import type { DbOrTx } from "@winston/db/client";
import { sites, siteVersions, users } from "@winston/db/schema";
import { BundleError, readBundle } from "@winston/site-host/bundle";
import type { SiteHost } from "@winston/site-host/host";
import { applyMigrations, MigrationError } from "@winston/site-host/migrations";
import {
  shareLink,
  siteNameProblem,
  siteUrl,
  type SiteRoute,
} from "@winston/site-host/route";
import { generateToken, hashToken } from "@winston/shared/tokens";
import { and, count, desc, eq, lt, lte, or } from "drizzle-orm";
import { Hono } from "hono";
import { validator } from "hono/validator";
import { z } from "zod";
import { ApiFailure } from "./connections.ts";
import type { VmApiEnv } from "./env.ts";
import type { VmFiles } from "./files.ts";

/** At most this many sites per user (the parent ticket's guardrails). */
export const maxSitesPerUser = 10;

export interface SiteDeps {
  host: SiteHost;
  blobs: BlobStore;
  /** Where sites are served: https://runwinston.app. */
  sitesUrl: string;
}

/** Each site keeps its newest versions' bundles, for rollback. */
export const keptVersions = 10;

const rollbackBody = z.object({
  /** The version to go back to; by default the one before the current. */
  to: z.number().int().positive().optional(),
});

const deployBody = z.object({
  /** The bundle the CLI packed, on the VM. */
  path: z.string().min(1),
  name: z.string().min(1),
});

type Site = typeof sites.$inferSelect;

/** A site's entry in the routes map (§9a): the share key only as its hash. */
const routeOf = (site: Site): SiteRoute => ({
  script: site.id,
  ownerId: site.userId,
  access: site.access,
  shareKeyHash:
    site.access === "link" && site.shareKey ? hashToken(site.shareKey) : null,
  paused: site.paused,
});

export function siteRoutes({
  db,
  sites: deps,
  vmFiles,
}: {
  db: DbOrTx;
  sites: SiteDeps | undefined;
  vmFiles: VmFiles | undefined;
}) {
  const dto = (site: Site) => ({
    id: site.id,
    name: site.name,
    url: deps ? siteUrl(deps.sitesUrl, site.name) : null,
    access: site.access,
    /** Opens the site for anyone, while it's shared by link. */
    shareLink:
      deps && site.access === "link" && site.shareKey
        ? shareLink(deps.sitesUrl, site.name, site.shareKey)
        : null,
    paused: site.paused,
    version: site.currentVersion,
    database: site.databaseId !== null,
    createdAt: site.createdAt.toISOString(),
    updatedAt: site.updatedAt.toISOString(),
  });

  const available = () => {
    if (!deps || !vmFiles)
      throw new ApiFailure(
        "unavailable",
        "Deploying sites isn't available here yet.",
        null,
      );
    return { ...deps, vmFiles };
  };

  /** The user's site with this id or name. */
  async function ownSite(userId: string, idOrName: string) {
    const wanted = idOrName.trim().toLowerCase();
    const [site] = await db
      .select()
      .from(sites)
      .where(
        and(
          eq(sites.userId, userId),
          or(eq(sites.id, wanted), eq(sites.name, wanted)),
        ),
      );
    if (!site)
      throw new ApiFailure(
        "not_found",
        `You have no site ${idOrName}.`,
        "winston site list shows them.",
      );
    return site;
  }

  /**
   * The site with this name, the user's own or newly claimed. Locks the
   * user's row, so two deploys can't both take the last free place.
   */
  async function claim(userId: string, name: string, sitesUrl: string) {
    return db.transaction(async (tx) => {
      await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, userId))
        .for("update");
      const [existing] = await tx
        .select()
        .from(sites)
        .where(eq(sites.name, name));
      if (existing && existing.userId !== userId)
        throw new ApiFailure(
          "conflict",
          `${siteUrl(sitesUrl, name)} is taken.`,
          "Pick another name with --name, e.g. one with the user's first name in it.",
        );
      if (existing) return existing;
      const problem = siteNameProblem(name);
      if (problem)
        throw new ApiFailure(
          "invalid_request",
          problem,
          "Pick another name with --name.",
        );
      const [owned] = await tx
        .select({ total: count() })
        .from(sites)
        .where(eq(sites.userId, userId));
      if ((owned?.total ?? 0) >= maxSitesPerUser)
        throw new ApiFailure(
          "conflict",
          `The user already has ${String(maxSitesPerUser)} sites, the most there can be.`,
          "Redeploy over one of them instead (winston site list).",
        );
      const [site] = await tx
        .insert(sites)
        .values({ userId, name })
        .returning();
      if (!site) throw new Error("the site wasn't created");
      return site;
    });
  }

  /**
   * Deletes pruned bundles no version still uses. Blobs are keyed by
   * content, so another version (this site redeployed unchanged, or another
   * site) can share one.
   */
  async function deleteUnusedBundles(blobs: BlobStore, keys: string[]) {
    for (const key of new Set(keys)) {
      const [used] = await db
        .select({ id: siteVersions.id })
        .from(siteVersions)
        .where(eq(siteVersions.bundleKey, key))
        .limit(1);
      if (!used) await blobs.delete(key);
    }
  }

  /** Changes who may open a site: the row and its route together. */
  async function setAccess(
    userId: string,
    idOrName: string,
    changes: Pick<Site, "access" | "shareKey">,
  ) {
    const { host } = available();
    const site = await ownSite(userId, idOrName);
    if (site.currentVersion === null)
      throw new ApiFailure(
        "conflict",
        `${site.name} hasn't been deployed yet.`,
        "Deploy it first with winston site deploy.",
      );
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

  return (
    new Hono<VmApiEnv>()
      .get("/", async (c) => {
        const rows = await db
          .select()
          .from(sites)
          .where(eq(sites.userId, c.get("run").userId))
          .orderBy(desc(sites.updatedAt));
        return c.json({ sites: rows.map(dto) });
      })
      .get("/:site", async (c) => {
        const site = await ownSite(c.get("run").userId, c.req.param("site"));
        return c.json({ site: dto(site) });
      })
      // Shared already: the same link. Shared again after unsharing: a new one.
      .post("/:site/share", async (c) => {
        const { userId } = c.get("run");
        const current = await ownSite(userId, c.req.param("site"));
        const site =
          current.access === "link" && current.shareKey
            ? current
            : await setAccess(userId, current.id, {
                access: "link",
                shareKey: generateToken(),
              });
        return c.json({ site: dto(site) });
      })
      .get("/:site/versions", async (c) => {
        const site = await ownSite(c.get("run").userId, c.req.param("site"));
        const rows = await db
          .select()
          .from(siteVersions)
          .where(eq(siteVersions.siteId, site.id))
          .orderBy(desc(siteVersions.number));
        return c.json({
          site: dto(site),
          versions: rows.map((row) => ({
            number: row.number,
            size: row.size,
            current: row.number === site.currentVersion,
            deployedAt: row.createdAt.toISOString(),
          })),
        });
      })
      .post(
        "/:site/rollback",
        validator("json", (value) => {
          const parsed = rollbackBody.safeParse(value ?? {});
          if (!parsed.success)
            throw new ApiFailure(
              "invalid_request",
              z.prettifyError(parsed.error),
              "Pass --to <version>; winston site versions lists them.",
            );
          return parsed.data;
        }),
        async (c) => {
          const { host, blobs } = available();
          const { userId } = c.get("run");
          const { to } = c.req.valid("json");
          const claimed = await ownSite(userId, c.req.param("site"));
          const site = await db.transaction(async (tx) => {
            const [locked = claimed] = await tx
              .select()
              .from(sites)
              .where(eq(sites.id, claimed.id))
              .for("update");
            const current = locked.currentVersion;
            if (current === null)
              throw new ApiFailure(
                "conflict",
                `${locked.name} hasn't been deployed yet.`,
                "Deploy it first with winston site deploy.",
              );
            // By default the newest version before the current one.
            const [target] = await tx
              .select()
              .from(siteVersions)
              .where(
                and(
                  eq(siteVersions.siteId, locked.id),
                  to === undefined
                    ? lt(siteVersions.number, current)
                    : eq(siteVersions.number, to),
                ),
              )
              .orderBy(desc(siteVersions.number))
              .limit(1);
            if (!target)
              throw new ApiFailure(
                "not_found",
                to === undefined
                  ? `${locked.name} has no version before ${String(current)} to go back to.`
                  : `${locked.name} has no version ${String(to)} (only the last ${String(keptVersions)} are kept).`,
                "winston site versions lists them.",
              );
            if (target.number === current)
              throw new ApiFailure(
                "conflict",
                `${locked.name} is already on version ${String(current)}.`,
                null,
              );
            const { script } = await readBundle(
              await blobs.get(target.bundleKey),
            );
            await host.putScript(locked.id, {
              ...script,
              databaseId: locked.databaseId ?? undefined,
            });
            const [updated] = await tx
              .update(sites)
              .set({ currentVersion: target.number, updatedAt: new Date() })
              .where(eq(sites.id, locked.id))
              .returning();
            return updated ?? locked;
          });
          return c.json({
            site: dto(site),
            note: "The database stays as it is: rollback restores the code and files, not data or migrations.",
          });
        },
      )
      .post("/:site/unshare", async (c) => {
        const site = await setAccess(c.get("run").userId, c.req.param("site"), {
          access: "private",
          shareKey: null,
        });
        return c.json({ site: dto(site) });
      })
      .post(
        "/deploy",
        validator("json", (value) => {
          const parsed = deployBody.safeParse(value);
          if (!parsed.success)
            throw new ApiFailure(
              "invalid_request",
              z.prettifyError(parsed.error),
              "Run winston site deploy <folder>.",
            );
          return parsed.data;
        }),
        async (c) => {
          const { host, blobs, sitesUrl, vmFiles } = available();
          const { userId } = c.get("run");
          const { path, name } = c.req.valid("json");

          let bytes: Uint8Array;
          try {
            bytes = await vmFiles.read(userId, path);
          } catch (error) {
            throw new ApiFailure(
              "invalid_request",
              `Couldn't read the site's bundle: ${error instanceof Error ? error.message : String(error)}`,
              "Run winston site deploy again.",
            );
          }
          let bundle: Awaited<ReturnType<typeof readBundle>>;
          try {
            bundle = await readBundle(bytes);
          } catch (error) {
            if (error instanceof BundleError)
              throw new ApiFailure("invalid_request", error.message, null);
            throw error;
          }

          const claimed = await claim(userId, name, sitesUrl);
          // Its own step, so the database is kept even if this deploy fails.
          if (!claimed.databaseId && bundle.migrations.length > 0)
            await db.transaction(async (tx) => {
              const [site] = await tx
                .select({ databaseId: sites.databaseId })
                .from(sites)
                .where(eq(sites.id, claimed.id))
                .for("update");
              if (site && !site.databaseId)
                await tx
                  .update(sites)
                  .set({ databaseId: await host.createDatabase(claimed.id) })
                  .where(eq(sites.id, claimed.id));
            });
          // The rest runs under a lock on the site, one deploy at a time.
          const result = await db.transaction(async (tx) => {
            const [site = claimed] = await tx
              .select()
              .from(sites)
              .where(eq(sites.id, claimed.id))
              .for("update");
            const databaseId = site.databaseId;
            let migrated: string[] = [];
            if (databaseId)
              try {
                migrated = await applyMigrations(
                  host,
                  databaseId,
                  bundle.migrations,
                );
              } catch (error) {
                if (error instanceof MigrationError)
                  throw new ApiFailure(
                    "invalid_request",
                    `Migration ${error.message}`,
                    error.applied.length
                      ? `${error.applied.join(", ")} did apply. Fix the failing one and deploy again; nothing was deployed.`
                      : "Fix it and deploy again; nothing was deployed.",
                  );
                throw error;
              }
            const bundleKey = await blobs.put(bytes);
            await host.putScript(site.id, {
              ...bundle.script,
              databaseId: databaseId ?? undefined,
            });
            await host.setRoute(site.name, routeOf(site));
            const [latest] = await tx
              .select({ number: siteVersions.number })
              .from(siteVersions)
              .where(eq(siteVersions.siteId, site.id))
              .orderBy(desc(siteVersions.number))
              .limit(1);
            const version = (latest?.number ?? 0) + 1;
            await tx.insert(siteVersions).values({
              siteId: site.id,
              number: version,
              bundleKey,
              size: bytes.byteLength,
            });
            const pruned = await tx
              .delete(siteVersions)
              .where(
                and(
                  eq(siteVersions.siteId, site.id),
                  lte(siteVersions.number, version - keptVersions),
                ),
              )
              .returning({ bundleKey: siteVersions.bundleKey });
            const [updated] = await tx
              .update(sites)
              .set({
                databaseId,
                currentVersion: version,
                updatedAt: new Date(),
              })
              .where(eq(sites.id, site.id))
              .returning();
            return {
              site: updated ?? site,
              migrated,
              pruned: pruned.map((row) => row.bundleKey),
            };
          });
          // After the commit, so a failed deploy never loses a kept bundle.
          await deleteUnusedBundles(blobs, result.pruned);
          return c.json({ site: dto(result.site), migrated: result.migrated });
        },
      )
  );
}
