/**
 * Starts a background run by hand, until the front of house can delegate
 * (docs/design.md §1):
 *
 *   bun run task:start <email> "<brief>" [--effort low|medium|high]
 *
 * It works on whatever DATABASE_URL points at; the agents service picks the
 * run up from the queue.
 */
import { createDb } from "@winston/db/client";
import { loadDbConfig } from "@winston/db/config";
import { users } from "@winston/db/schema";
import { eq } from "drizzle-orm";
import type { Effort } from "../model/gateway.ts";
import { startBackgroundRun } from "./run.ts";

const args = process.argv.slice(2);
const effortAt = args.indexOf("--effort");
const effort = effortAt === -1 ? undefined : args[effortAt + 1];
const [email, brief] = args.filter(
  (_, i) => effortAt === -1 || (i !== effortAt && i !== effortAt + 1),
);
if (
  !email ||
  !brief ||
  (effort !== undefined && !["low", "medium", "high"].includes(effort))
) {
  console.error(
    'Usage: bun run task:start <email> "<brief>" [--effort low|medium|high]',
  );
  process.exit(1);
}
const config = loadDbConfig();
const db = createDb(config.DATABASE_URL, {
  rdsSecretArn: config.DATABASE_SECRET_ARN,
});
const [user] = await db
  .select({ id: users.id })
  .from(users)
  .where(eq(users.email, email.trim().toLowerCase()));
if (!user) {
  console.error(`No user ${email}.`);
  process.exit(1);
}
const runId = await startBackgroundRun(db, {
  userId: user.id,
  brief,
  ...(effort ? { effort: effort as Effort } : {}),
});
console.log(`Started ${runId}.`);
await db.$client.end();
