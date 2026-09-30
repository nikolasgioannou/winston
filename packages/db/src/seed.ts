/**
 * Seeds the local database with the user described by the SEED_* values in
 * .env.local, and requests their computer the way sign-up does (bun dev's
 * agents service provisions it). Refuses to touch non-local databases.
 */
import { loadConfig } from "@winston/shared/config";
import { z } from "zod";
import { createDb } from "./client.ts";
import { assertLocalDatabase, loadDbConfig } from "./config.ts";
import { seedUser } from "./seed-user.ts";
import { requestVm } from "./vms.ts";

const blankAsUndefined = (value: unknown) => (value === "" ? undefined : value);

const seedConfigSchema = z.object({
  SEED_EMAIL: z.email().transform((email) => email.toLowerCase()),
  SEED_FIRST_NAME: z.string().min(1),
  SEED_LAST_NAME: z.string().min(1),
  SEED_TIMEZONE: z.string().refine(isTimeZone, "must be an IANA time zone"),
  SEED_TELEGRAM_CHAT_ID: z.preprocess(
    blankAsUndefined,
    z.coerce.number().int().optional(),
  ),
});

function isTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const { DATABASE_URL } = loadDbConfig();
assertLocalDatabase(DATABASE_URL, "seed");
const seed = loadConfig(seedConfigSchema);
const db = createDb(DATABASE_URL);

try {
  const userId = await seedUser(db, {
    email: seed.SEED_EMAIL,
    firstName: seed.SEED_FIRST_NAME,
    lastName: seed.SEED_LAST_NAME,
    timezone: seed.SEED_TIMEZONE,
    telegramChatId: seed.SEED_TELEGRAM_CHAT_ID,
  });
  const requested = await requestVm(db, userId);
  console.log(
    `Seeded ${seed.SEED_EMAIL} (${userId})${requested ? "; their computer is requested" : ""}.`,
  );
} finally {
  await db.$client.end();
}
