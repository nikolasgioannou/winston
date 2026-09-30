import type { DbOrTx } from "@winston/db/client";
import { connections, telegramLinks } from "@winston/db/schema";
import { computerStatus } from "@winston/db/vms";
import { and, count, eq, ne } from "drizzle-orm";
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
  const [accounts] = await db
    .select({ n: count() })
    .from(connections)
    .where(
      and(
        eq(connections.userId, user.id),
        ne(connections.status, "disconnected"),
      ),
    );
  return {
    firstName: user.firstName,
    computer: await computerStatus(db, user.id),
    telegramLinked: link !== undefined,
    accountsConnected: accounts?.n ?? 0,
    attention: [],
  };
}
