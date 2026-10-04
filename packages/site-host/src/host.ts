import type { SiteRoute } from "./route.ts";

/**
 * Sites' Workers' compatibility date, on both hosts: the newest the local
 * host's pinned Miniflare accepts (docs/design.md §9a).
 */
export const compatibilityDate = "2026-08-01";

/** A site's Worker as it's uploaded: ES modules (the first is the entry) and static assets. */
export interface SiteScript {
  modules: { name: string; content: string }[];
  /** Paths from the site's root (`/index.html`). */
  assets: { path: string; content: Uint8Array }[];
  /** Its database, bound as `DB`. */
  databaseId?: string | undefined;
}

/** A statement for a site's database, with `?` parameters. */
export interface SqlStatement {
  sql: string;
  params?: unknown[];
}

/**
 * Where sites run (docs/design.md §9a): Cloudflare Workers for Platforms in
 * production, a local Miniflare host for the dev stack (`apps/sites`). Like
 * `VmProvider`, small and shaped for the real platform.
 */
export interface SiteHost {
  kind: "local" | "cloudflare";
  /** Uploads a site's Worker, replacing any earlier one with that name. */
  putScript(script: string, upload: SiteScript): Promise<void>;
  /** Removes a site's Worker. One that's already gone is fine. */
  deleteScript(script: string): Promise<void>;
  /** Points a site name at its route, or removes it (null), in the routes map. */
  setRoute(name: string, route: SiteRoute | null): Promise<void>;
  /** Creates a database (D1) for a site, returning its id. */
  createDatabase(name: string): Promise<string>;
  /** Deletes a database and its data. One that's already gone is fine. */
  deleteDatabase(databaseId: string): Promise<void>;
  /** Runs statements on a database in one transaction, returning each one's rows. */
  batchSql(
    databaseId: string,
    statements: SqlStatement[],
  ): Promise<Record<string, unknown>[][]>;
  /** The requests a site's Worker served, and the CPU time they took, in `[from, to)`. */
  usage(script: string, from: Date, to: Date): Promise<SiteUsage>;
  /** A database's size, in bytes. */
  databaseSize(databaseId: string): Promise<number>;
}

export interface SiteUsage {
  requests: number;
  cpuMs: number;
}
