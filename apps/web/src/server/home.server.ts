import type { DbOrTx } from "@winston/db/client";
import { telegramLinks } from "@winston/db/schema";
import { computerStatus } from "@winston/db/vms";
import { eq } from "drizzle-orm";
import type { HomeState } from "./home-state";

/** What `/home` shows the user (docs/design.md §20). */
export async function homeState(
  db: DbOrTx,
  user: { id: string; firstName: string },
): Promise<HomeState> {
  const [link] = await db
    .select({ userId: telegramLinks.userId })
    .from(telegramLinks)
    .where(eq(telegramLinks.userId, user.id));
  return {
    firstName: user.firstName,
    computer: await computerStatus(db, user.id),
    telegramLinked: link !== undefined,
    accountsConnected: 0,
    attention: [],
  };
}
