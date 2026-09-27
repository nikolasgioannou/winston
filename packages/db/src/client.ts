import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

/** Creates a Drizzle client backed by a postgres.js connection pool. */
export function createDb(databaseUrl: string) {
  return drizzle({
    client: postgres(databaseUrl, { onnotice: () => undefined }),
  });
}

export type Db = ReturnType<typeof createDb>;

/** A transaction handle, as passed to `db.transaction(async (tx) => …)`. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Anything queries can run on: the client itself or a transaction. */
export type DbOrTx = Db | Tx;
