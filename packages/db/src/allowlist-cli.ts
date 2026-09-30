/**
 * Manages who may sign in (docs/design.md §5, Access control):
 *
 *   bun run allowlist list
 *   bun run allowlist add <email>
 *   bun run allowlist remove <email>
 *
 * It works on whatever DATABASE_URL points at, and says which one first.
 */
import {
  allowEmail,
  disallowEmail,
  listAllowedEmails,
  normalizeEmail,
} from "./allowlist.ts";
import { createDb } from "./client.ts";
import { loadDbConfig } from "./config.ts";

// Signing in only needs the allowlist; connecting mail or calendar needs
// Google's test-user list too, for every account they connect.
const googleReminder =
  "They can sign in now. Before they connect mail or calendar, add this address, and any other Google account they'll connect, as a test user on the Google OAuth consent screen (docs/runbooks/google-cloud.md), or connecting will fail.";

const say = (message: string) => {
  console.log(message);
};

const [command, input] = Bun.argv.slice(2);
const { DATABASE_URL } = loadDbConfig();
const db = createDb(DATABASE_URL);

try {
  say(`Database: ${new URL(DATABASE_URL).host}`);
  if (command === "list") {
    const rows = await listAllowedEmails(db);
    if (rows.length === 0) say("No one is on the allowlist.");
    for (const row of rows)
      say(`${row.email}  (added ${row.addedAt.toISOString().slice(0, 10)})`);
  } else if (command === "add" || command === "remove") {
    const email = normalizeEmail(input ?? "");
    if (!email) {
      say(`"${input ?? ""}" isn't an email address.`);
      process.exitCode = 1;
    } else if (command === "add") {
      say(
        (await allowEmail(db, email))
          ? `Added ${email}.`
          : `${email} was already on the allowlist.`,
      );
      say(googleReminder);
    } else {
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
    }
  } else {
    say("usage: bun run allowlist list | add <email> | remove <email>");
    process.exitCode = 1;
  }
} finally {
  await db.$client.end();
}
