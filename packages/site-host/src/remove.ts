import type { BlobStore } from "@winston/blobs";
import type { DbOrTx } from "@winston/db/client";
import { sites, siteVersions } from "@winston/db/schema";
import { eq } from "drizzle-orm";
import type { SiteHost } from "./host.ts";

/**
 * Deletes bundles no site version still uses. Blobs are keyed by content,
 * so another version (a site redeployed unchanged, or another site) can
 * share one.
 */
export async function deleteUnusedBundles(
  db: DbOrTx,
  blobs: BlobStore,
  keys: string[],
) {
  for (const key of new Set(keys)) {
    const [used] = await db
      .select({ id: siteVersions.id })
      .from(siteVersions)
      .where(eq(siteVersions.bundleKey, key))
      .limit(1);
    if (!used) await blobs.delete(key);
  }
}

/**
 * Takes a site down for good (docs/design.md §9a): its address first, so it
 * stops answering at once, then its Worker, its database, its row and
 * versions, and bundles nothing else uses. The name is free again. Every
 * step is safe to repeat, so a retry after a failure finishes the job.
 */
export async function removeSite(
  { db, host, blobs }: { db: DbOrTx; host: SiteHost; blobs: BlobStore },
  siteId: string,
) {
  const [site] = await db.select().from(sites).where(eq(sites.id, siteId));
  if (!site) return;
  await host.setRoute(site.name, null);
  await host.deleteScript(site.id);
  if (site.databaseId) await host.deleteDatabase(site.databaseId);
  const versions = await db
    .select({ bundleKey: siteVersions.bundleKey })
    .from(siteVersions)
    .where(eq(siteVersions.siteId, site.id));
  // Versions go with the row (cascade).
  await db.delete(sites).where(eq(sites.id, site.id));
  await deleteUnusedBundles(
    db,
    blobs,
    versions.map((version) => version.bundleKey),
  );
}
