import { notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import {
  connectionDtoColumns,
  disconnectConnection,
  setCapability,
  toConnectionDto,
} from "@winston/db/connections";
import { connections } from "@winston/db/schema";
import { unavailableCapabilities } from "@winston/domain/connections";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
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

const byId = z.object({ id: z.string().min(1) });

/**
 * `/accounts/<id>`'s loader: one of the user's connections, and the
 * capabilities its granted scopes don't cover.
 */
export const getAccount = createServerFn({ method: "GET" })
  .validator(byId)
  .handler(async ({ data }) => {
    const user = await requireUser();
    const [row] = await database()
      .select(connectionDtoColumns)
      .from(connections)
      .where(and(eq(connections.id, data.id), eq(connections.userId, user.id)));
    if (!row) throw notFound();
    const unavailable = unavailableCapabilities(
      row.provider,
      row.domain,
      row.scopes,
    );
    return { account: toConnectionDto(row), unavailable };
  });

export const setAccountCapability = createServerFn({ method: "POST" })
  .validator(
    byId.extend({ capability: z.string().min(1), enabled: z.boolean() }),
  )
  .handler(async ({ data }) => {
    const user = await requireUser();
    const capabilities = await setCapability(
      database(),
      user.id,
      data.id,
      data.capability,
      data.enabled,
    );
    if (!capabilities) throw notFound();
    return capabilities;
  });

export const disconnectAccount = createServerFn({ method: "POST" })
  .validator(byId)
  .handler(async ({ data }) => ({
    disconnected: await disconnectConnection(
      database(),
      (await requireUser()).id,
      data.id,
    ),
  }));
