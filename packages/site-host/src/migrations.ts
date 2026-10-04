import type { SiteHost } from "./host.ts";
import { splitSql } from "./sql.ts";

/** A migration file from a site's bundle: `migrations/0001_notes.sql`. */
export interface SiteMigration {
  name: string;
  sql: string;
}

const table = "_winston_migrations";

/**
 * Applies a site's migrations that haven't been yet, in name order
 * (docs/design.md §9a). Which ones have is recorded in the database itself,
 * as wrangler does. Each migration runs as one batch with its record, so it
 * applies whole or not at all. Returns the names applied.
 */
export async function applyMigrations(
  host: SiteHost,
  databaseId: string,
  migrations: SiteMigration[],
  now = new Date(),
): Promise<string[]> {
  const [, rows = []] = await host.batchSql(databaseId, [
    {
      sql: `CREATE TABLE IF NOT EXISTS ${table} (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`,
    },
    { sql: `SELECT name FROM ${table}` },
  ]);
  const done = new Set(rows.map((row) => row.name));
  const applied: string[] = [];
  for (const migration of [...migrations].sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    if (done.has(migration.name)) continue;
    try {
      await host.batchSql(databaseId, [
        ...splitSql(migration.sql).map((sql) => ({ sql })),
        {
          sql: `INSERT INTO ${table} (name, applied_at) VALUES (?, ?)`,
          params: [migration.name, now.toISOString()],
        },
      ]);
    } catch (error) {
      throw new MigrationError(migration.name, applied, error);
    }
    applied.push(migration.name);
  }
  return applied;
}

/** A migration failed; the ones before it were applied, and it wasn't. */
export class MigrationError extends Error {
  constructor(
    readonly migration: string,
    readonly applied: string[],
    cause: unknown,
  ) {
    super(
      `${migration} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}
