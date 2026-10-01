/**
 * Manages who may sign in (docs/design.md §5, Access control):
 *
 *   bun run allowlist list
 *   bun run allowlist add <email>
 *   bun run allowlist remove <email>
 *
 * It works on whatever DATABASE_URL points at, and says which one first.
 * In production it runs through `bun run prod allowlist …` (src/ops.ts).
 */
import {
  allowEmail,
  disallowEmail,
  listAllowedEmails,
  normalizeEmail,
} from "./allowlist.ts";
import { createDb, type Db } from "./client.ts";
import { loadDbConfig } from "./config.ts";

// Signing in only needs the allowlist; connecting mail or calendar needs
// Google's test-user list too, for every account they connect.
const googleReminder =
  "They can sign in now. Before they connect mail or calendar, add this address, and any other Google account they'll connect, as a test user on the Google OAuth consent screen (docs/runbooks/google-cloud.md), or connecting will fail.";

const say = (message: string) => {
  console.log(message);
};

/** Runs `list`, `add <email>` or `remove <email>`; returns the exit code. */
export async function allowlistCommand(
  db: Db,
  [command, input]: string[],
): Promise<number> {
  if (command === "list") {
    const rows = await listAllowedEmails(db);
    if (rows.length === 0) say("No one is on the allowlist.");
    for (const row of rows)
      say(`${row.email}  (added ${row.addedAt.toISOString().slice(0, 10)})`);
    return 0;
  }
  if (command === "add" || command === "remove") {
    const email = normalizeEmail(input ?? "");
    if (!email) {
      say(`"${input ?? ""}" isn't an email address.`);
      return 1;
    }
    if (command === "add") {
      say(
        (await allowEmail(db, email))
          ? `Added ${email}.`
          : `${email} was already on the allowlist.`,
      );
      say(googleReminder);
      return 0;
    }
    const { wasListed, hasAccount } = await disallowEmail(db, email);
    say(
      wasListed
        ? `Removed ${email}; they can't sign in from now on.`
        : `${email} wasn't on the allowlist.`,
    );
    if (hasAccount)
      say(
        "Their account still exists, with everything in it: removing an email doesn't delete it. They can delete it from their profile.",
      );
    return 0;
  }
  say("usage: allowlist list | add <email> | remove <email>");
  return 1;
}

if (import.meta.main) {
  const { DATABASE_URL, DATABASE_SECRET_ARN } = loadDbConfig();
  const db = createDb(DATABASE_URL, { rdsSecretArn: DATABASE_SECRET_ARN });
  try {
    say(`Database: ${new URL(DATABASE_URL).host}`);
    process.exitCode = await allowlistCommand(db, Bun.argv.slice(2));
  } finally {
    await db.$client.end();
  }
}
