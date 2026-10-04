import { createServerFn } from "@tanstack/react-start";
import { database } from "./db.server";
import { requireUser } from "./session.server";
import { telegramLinkOf } from "./telegram.server";

/** `/channels`'s loader. */
export const getChannelsState = createServerFn({ method: "GET" }).handler(
  async () => ({
    telegram: await telegramLinkOf(database(), (await requireUser()).id),
  }),
);
