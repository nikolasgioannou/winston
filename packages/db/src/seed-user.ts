import type { DbOrTx } from "./client.ts";
import { allowedEmails, telegramLinks, users } from "./schema/index.ts";

export interface SeedUserInput {
  email: string;
  firstName: string;
  lastName: string;
  timezone: string;
  telegramChatId?: number | undefined;
}

/**
 * Upserts a user by email, allowlists the email and, when given, links a
 * Telegram chat. Safe to run repeatedly. Returns the user's id.
 */
export async function seedUser(db: DbOrTx, input: SeedUserInput) {
  return db.transaction(async (tx) => {
    const profile = {
      firstName: input.firstName,
      lastName: input.lastName,
      timezone: input.timezone,
    };
    const [user] = await tx
      .insert(users)
      .values({ email: input.email, ...profile })
      .onConflictDoUpdate({ target: users.email, set: profile })
      .returning({ id: users.id });
    if (!user) throw new Error("Upserting the seed user returned no row.");

    await tx
      .insert(allowedEmails)
      .values({ email: input.email })
      .onConflictDoNothing();

    if (input.telegramChatId !== undefined) {
      // In a private chat, the chat id is the user's Telegram id.
      const chat = {
        chatId: input.telegramChatId,
        telegramUserId: input.telegramChatId,
      };
      await tx
        .insert(telegramLinks)
        .values({ userId: user.id, ...chat })
        .onConflictDoUpdate({ target: telegramLinks.userId, set: chat });
    }

    return user.id;
  });
}
