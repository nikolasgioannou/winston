import { createServerFn } from "@tanstack/react-start";
import { database } from "./db.server";
import { requireUser } from "./session.server";
import { telegramLinkOf } from "./telegram.server";

/** `/profile`'s loader. */
export const getProfileState = createServerFn({ method: "GET" }).handler(
  async () => {
    const user = await requireUser();
    return {
      email: user.email,
      telegram: await telegramLinkOf(database(), user.id),
    };
  },
);
