/**
 * Production operations (docs/design.md §19, docs/runbooks/production.md),
 * run as one-off ECS tasks by `bun run prod <command>` on the `ops` image,
 * which bundles this file with the migrations:
 *
 *   migrate                          apply pending migrations
 *   allowlist list|add|remove …      who may sign in
 *   sql "<query>"                    a read-only query, rows printed as JSON
 *   vm:restore <email>               restore a user's VM from its latest snapshot
 *   vm:roll <email>                  move a user's VM onto the current image now
 */
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { restoreVmJob, rollVmJob } from "@winston/domain/jobs";
import { eq } from "drizzle-orm";
import { allowlistCommand } from "./allowlist-cli.ts";
import { createDb, type Db } from "./client.ts";
import { loadDbConfig } from "./config.ts";
import { enqueue } from "./queue.ts";
import { users } from "./schema/index.ts";

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
    case "vm:roll": {
      const [email] = args;
      const [user] = email
        ? await db
            .select({ id: users.id })
            .from(users)
            .where(eq(users.email, email.trim().toLowerCase()))
        : [];
      if (!user) {
        console.log(`usage: vm:roll <email of an existing user>`);
        return 1;
      }
      // Now rather than in the quiet hours; still not while it's busy.
      await enqueue(db, rollVmJob.type, {
        userId: user.id,
        payload: { now: true },
        dedupeKey: rollVmJob.dedupeKey(user.id),
        maxAttempts: rollVmJob.maxAttempts,
      });
      console.log(
        "Queued: the VM moves onto the current image unless it's current or busy (agents logs say which).",
      );
      return 0;
    }
    case "vm:restore": {
      const [email] = args;
      const [user] = email
        ? await db
            .select({ id: users.id })
            .from(users)
            .where(eq(users.email, email.trim().toLowerCase()))
        : [];
      if (!user) {
        console.log(`usage: vm:restore <email of an existing user>`);
        return 1;
      }
      await enqueue(db, restoreVmJob.type, {
        userId: user.id,
        dedupeKey: restoreVmJob.dedupeKey(user.id),
        maxAttempts: restoreVmJob.maxAttempts,
      });
      console.log(
        `Queued a restore of ${email ?? ""}'s VM from its latest snapshot; agents runs it (docs/runbooks/vm-recovery.md).`,
      );
      return 0;
    }
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
      console.log(
        "usage: migrate | allowlist list|add|remove … | sql <query> | vm:restore <email>",
      );
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
