/**
 * Production operations (docs/design.md §19, docs/runbooks/production.md),
 * run as one-off ECS tasks by `bun run prod <command>` on the `ops` image,
 * which bundles this file with the migrations:
 *
 *   migrate                          apply pending migrations
 *   allowlist list|add|remove …      who may sign in
 *   sql "<query>"                    a read-only query, rows printed as JSON
 */
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { allowlistCommand } from "./allowlist-cli.ts";
import { createDb, type Db } from "./client.ts";
import { loadDbConfig } from "./config.ts";

/** Runs a query in a read-only transaction, so it can't change anything. */
export async function readOnlyQuery(db: Db, query: string) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set transaction read only`);
    return tx.execute(sql.raw(query));
  });
}

async function run(db: Db, [command, ...args]: string[]): Promise<number> {
  switch (command ?? "") {
    case "migrate": {
      const migrationsFolder =
        process.env.MIGRATIONS_DIR ??
        new URL("../migrations", import.meta.url).pathname;
      await migrate(db, { migrationsFolder });
      console.log("Migrations are up to date.");
      return 0;
    }
    case "allowlist":
      return allowlistCommand(db, args);
    case "sql": {
      const [query] = args;
      if (!query) {
        console.log('usage: sql "<query>"');
        return 1;
      }
      for (const row of await readOnlyQuery(db, query))
        console.log(JSON.stringify(row));
      return 0;
    }
    default:
      console.log("usage: migrate | allowlist list|add|remove … | sql <query>");
      return 1;
  }
}

if (import.meta.main) {
  const { DATABASE_URL, DATABASE_SECRET_ARN } = loadDbConfig();
  const db = createDb(DATABASE_URL, { rdsSecretArn: DATABASE_SECRET_ARN });
  try {
    console.log(`Database: ${new URL(DATABASE_URL).host}`);
    process.exitCode = await run(db, Bun.argv.slice(2));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    await db.$client.end();
  }
}
