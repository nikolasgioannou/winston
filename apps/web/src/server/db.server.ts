import { createDb, type Db } from "@winston/db/client";
import { webConfig } from "./config.server";

// Kept on globalThis, not in a module variable: in dev, Vite re-runs this
// module on every server reload in the same process, and each run would open
// a new pool while the old one kept its connections until Postgres ran out.
declare global {
  var winstonWebDb: Db | undefined;
}

/** The site's database connection, opened on first use. */
export function database() {
  const { DATABASE_URL, DATABASE_SECRET_ARN } = webConfig();
  return (globalThis.winstonWebDb ??= createDb(DATABASE_URL, {
    rdsSecretArn: DATABASE_SECRET_ARN,
  }));
}
