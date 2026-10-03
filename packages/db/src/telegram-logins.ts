/**
 * Telegram login claims (docs/design.md §13): a login button's signed data
 * carries no nonce, so each hash signs in once.
 */
import { lt, sql } from "drizzle-orm";
import type { DbOrTx } from "./client.ts";
import { telegramLogins } from "./schema/index.ts";

/** How long a used hash is remembered: a login is only accepted within two minutes. */
const keptMs = 24 * 60 * 60_000;

/** True the first time a hash is claimed, false after; old claims are cleared along the way. */
export async function claimTelegramLogin(
  db: DbOrTx,
  hash: string,
  now = new Date(),
) {
  await db
    .delete(telegramLogins)
    .where(lt(telegramLogins.usedAt, new Date(now.getTime() - keptMs)));
  const claimed = await db
    .insert(telegramLogins)
    .values({ hash, usedAt: sql`${now.toISOString()}::timestamptz` })
    .onConflictDoNothing()
    .returning({ hash: telegramLogins.hash });
  return claimed.length > 0;
}
