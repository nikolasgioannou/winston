/**
 * Seeds the local database with one user, allowlisted, optionally linked to a
 * Telegram chat. Safe to run repeatedly. Refuses to touch non-local databases.
 */
import { loadConfig } from "@winston/shared/config";
import { z } from "zod";
import { createDb } from "./client.ts";
import { loadDbConfig } from "./config.ts";
import { allowedEmails, telegramLinks, users } from "./schema/index.ts";

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
const { hostname } = new URL(DATABASE_URL);
if (hostname !== "localhost" && hostname !== "127.0.0.1") {
  throw new Error(`Refusing to seed a non-local database (${hostname}).`);
}

const seed = loadConfig(seedConfigSchema);
const db = createDb(DATABASE_URL);

try {
  await db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        email: seed.SEED_EMAIL,
        firstName: seed.SEED_FIRST_NAME,
        lastName: seed.SEED_LAST_NAME,
        timezone: seed.SEED_TIMEZONE,
      })
      .onConflictDoUpdate({
        target: users.email,
        set: {
          firstName: seed.SEED_FIRST_NAME,
          lastName: seed.SEED_LAST_NAME,
          timezone: seed.SEED_TIMEZONE,
        },
      })
      .returning({ id: users.id });
    if (!user) throw new Error("Upserting the seed user returned no row.");

    await tx
      .insert(allowedEmails)
      .values({ email: seed.SEED_EMAIL })
      .onConflictDoNothing();

    if (seed.SEED_TELEGRAM_CHAT_ID !== undefined) {
      // In a private chat, the chat id is the user's Telegram id.
      const chat = {
        chatId: seed.SEED_TELEGRAM_CHAT_ID,
        telegramUserId: seed.SEED_TELEGRAM_CHAT_ID,
      };
      await tx
        .insert(telegramLinks)
        .values({ userId: user.id, ...chat })
        .onConflictDoUpdate({ target: telegramLinks.userId, set: chat });
    }

    console.log(`Seeded ${seed.SEED_EMAIL} (${user.id}).`);
  });
} finally {
  await db.$client.end();
}
