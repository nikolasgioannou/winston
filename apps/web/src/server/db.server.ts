import { createDb, type Db } from "@winston/db/client";
import { webConfig } from "./config.server";

let db: Db | undefined;

/** The site's database connection, opened on first use. */
export function database() {
  const { DATABASE_URL, DATABASE_SECRET_ARN } = webConfig();
  return (db ??= createDb(DATABASE_URL, { rdsSecretArn: DATABASE_SECRET_ARN }));
}
