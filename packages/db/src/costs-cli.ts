/** `bun run costs [--user <email>] [--month YYYY-MM]`: spend on the local database (production: `bun run prod costs`). */
import { createDb } from "./client.ts";
import { loadDbConfig } from "./config.ts";
import { costsCommand } from "./costs.ts";

const config = loadDbConfig();
const db = createDb(config.DATABASE_URL);
const code = await costsCommand(db, Bun.argv.slice(2));
await db.$client.end();
process.exit(code);
