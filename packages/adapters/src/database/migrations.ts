import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import type { Pool } from "pg";

const migrationsFolder = fileURLToPath(new URL("../../migrations", import.meta.url));
export const migrationOptions = { migrationsFolder, migrationsSchema: "winston_migrations" };

type JournalRow = { hash: string; created_at: string };

export async function checkSchema(connection: Client | Pool, allowPending = false) {
  const expected = readMigrationFiles(migrationOptions);
  const exists = await connection.query<{ name: string | null }>(
    "SELECT to_regclass('winston_migrations.__drizzle_migrations')::text AS name",
  );
  const applied = exists.rows[0]?.name
    ? (
        await connection.query<JournalRow>(
          "SELECT hash, created_at FROM winston_migrations.__drizzle_migrations ORDER BY created_at",
        )
      ).rows
    : [];

  if (applied.length > expected.length || (!allowPending && applied.length !== expected.length)) {
    throw new Error(
      "Database schema is incompatible with this application. Run the matching release migrations.",
    );
  }

  for (const [index, row] of applied.entries()) {
    const migration = expected[index];

    if (
      !migration ||
      row.hash !== migration.hash ||
      Number(row.created_at) !== migration.folderMillis
    ) {
      throw new Error(
        "Applied migration history differs from this release. Published migrations are immutable.",
      );
    }
  }
}

export async function migrateDatabase(directConnectionString: string) {
  const url = new URL(directConnectionString);

  if (url.hostname.startsWith("pgbouncer.")) {
    throw new Error("Migrations require DIRECT_DATABASE_URL, not Fly's pooled endpoint.");
  }

  const client = new Client({
    connectionString: directConnectionString,
    connectionTimeoutMillis: 10_000,
  });

  try {
    await client.connect();
    // This lock belongs to the dedicated connection, including all migration transactions.
    await client.query("SET lock_timeout = '30s'");
    await client.query("SELECT pg_advisory_lock(194872, 1)");
    await checkSchema(client, true);
    await migrate(drizzle(client), migrationOptions);
    await checkSchema(client);
  } finally {
    // Closing also releases the advisory lock, including after a migration failure.
    await client.end();
  }
}
