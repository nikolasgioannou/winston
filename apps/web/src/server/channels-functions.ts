import { createServerFn } from "@tanstack/react-start";
import {
  changeMailboxAddress,
  checkMailboxName,
  mailboxState,
  turnOffMailbox,
  turnOnMailbox,
} from "@winston/db/mailbox";
import { z } from "zod";
import { database } from "./db.server";
import { requireUser } from "./session.server";
import { telegramLinkOf } from "./telegram.server";

/** `/channels`'s loader: Telegram and Winston's own mailbox. */
export const getChannelsState = createServerFn({ method: "GET" }).handler(
  async () => {
    const { id } = await requireUser();
    return {
      telegram: await telegramLinkOf(database(), id),
      mailbox: await mailboxState(database(), id),
    };
  },
);

const byName = z.object({ name: z.string().max(100) });

/** Whether a name could be Winston's address, as the user types it. */
export const checkMailboxNameFn = createServerFn({ method: "POST" })
  .validator(byName)
  .handler(async ({ data }) => {
    await requireUser();
    return checkMailboxName(database(), data.name);
  });

/** Sets Winston's mailbox up with a name, or turns it back on. */
export const turnOnMailboxFn = createServerFn({ method: "POST" })
  .validator(z.object({ name: z.string().max(100).optional() }))
  .handler(async ({ data }) =>
    turnOnMailbox(database(), (await requireUser()).id, data.name),
  );

export const changeMailboxAddressFn = createServerFn({ method: "POST" })
  .validator(byName)
  .handler(async ({ data }) =>
    changeMailboxAddress(database(), (await requireUser()).id, data.name),
  );

export const turnOffMailboxFn = createServerFn({ method: "POST" }).handler(
  async () => ({
    turnedOff: await turnOffMailbox(database(), (await requireUser()).id),
  }),
);
