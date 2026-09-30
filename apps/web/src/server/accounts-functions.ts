import { createServerFn } from "@tanstack/react-start";
import { connectionDtoColumns, toConnectionDto } from "@winston/db/connections";
import { connections } from "@winston/db/schema";
import { asc, eq } from "drizzle-orm";
import { database } from "./db.server";
import { requireUser } from "./session.server";

/** `/accounts`'s loader: the user's connections, oldest first, as DTOs. */
export const getAccounts = createServerFn({ method: "GET" }).handler(
  async () => {
    const user = await requireUser();
    const rows = await database()
      .select(connectionDtoColumns)
      .from(connections)
      .where(eq(connections.userId, user.id))
      .orderBy(asc(connections.createdAt));
    return rows.map(toConnectionDto);
  },
);
