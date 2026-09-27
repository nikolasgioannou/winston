import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

/** Creates a Drizzle client backed by a postgres.js connection pool. */
export function createDb(databaseUrl: string) {
  return drizzle({ client: postgres(databaseUrl) });
}

export type Db = ReturnType<typeof createDb>;
