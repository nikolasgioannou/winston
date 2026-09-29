import { createDb, type Db } from "@winston/db/client";
import { webConfig } from "./config.server";

let db: Db | undefined;

/** The site's database connection, opened on first use. */
export function database() {
  return (db ??= createDb(webConfig().DATABASE_URL));
}
