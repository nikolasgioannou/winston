import type { DbOrTx } from "@winston/db/client";
import { googleBacked } from "@winston/db/connections";
import { connections, telegramLinks } from "@winston/db/schema";
import { computerStatus } from "@winston/db/vms";
import { and, asc, count, eq, inArray, ne } from "drizzle-orm";
import type { AttentionItem, HomeState } from "./home-state";

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
        googleBacked,
        ne(connections.status, "disconnected"),
      ),
    );
  const needingReconnect = await db
    .select({
      id: connections.id,
      domain: connections.domain,
      externalEmail: connections.externalEmail,
      status: connections.status,
    })
    .from(connections)
    .where(
      and(
        eq(connections.userId, user.id),
        inArray(connections.status, ["expired", "expiring"]),
      ),
    )
    .orderBy(asc(connections.createdAt));
  const attention = needingReconnect
    .map((connection): AttentionItem => {
      const kind = connection.domain === "mail" ? "Mail" : "Calendar";
      const expired = connection.status === "expired";
      return {
        id: connection.id,
        tone: expired ? "error" : "attention",
        title: expired
          ? `${kind} access for ${connection.externalEmail} expired`
          : `${kind} access for ${connection.externalEmail} expires soon`,
        description: `Reconnect so Winston can ${expired ? "help with it again" : "keep helping with it"}.`,
        action: {
          label: "Reconnect",
          href: `/auth/google/connect?reconnect=${connection.id}`,
        },
      };
    })
    // Expired first: they've already stopped working.
    .sort((a, b) => (a.tone === b.tone ? 0 : a.tone === "error" ? -1 : 1));
  return {
    firstName: user.firstName,
    computer: await computerStatus(db, user.id),
    telegramLinked: link !== undefined,
    accountsConnected: accounts?.n ?? 0,
    attention,
  };
}
