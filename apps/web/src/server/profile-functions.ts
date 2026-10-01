import { createServerFn } from "@tanstack/react-start";
import { requestAccountDeletion } from "@winston/db/account-deletion";
import { updateProfile } from "@winston/db/profile";
import { z } from "zod";
import { database } from "./db.server";
import { endSession, requireUser } from "./session.server";
import { telegramLinkOf } from "./telegram.server";

/** `/profile`'s loader. */
export const getProfileState = createServerFn({ method: "GET" }).handler(
  async () => {
    const user = await requireUser();
    return {
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      telegram: await telegramLinkOf(database(), user.id),
    };
  },
);

/** Saves the user's name, through the one shared profile path. */
export const saveProfile = createServerFn({ method: "POST" })
  .validator(
    z.object({
      firstName: z.string().optional(),
      lastName: z.string().optional(),
    }),
  )
  .handler(async ({ data }) =>
    updateProfile(
      database(),
      (await requireUser()).id,
      {
        ...(data.firstName !== undefined ? { firstName: data.firstName } : {}),
        ...(data.lastName !== undefined ? { lastName: data.lastName } : {}),
      },
      "site",
    ),
  );

/**
 * Follows the browser's time zone (docs/design.md §20): the shell calls it
 * once per app load when the browser's zone differs from the saved one.
 */
export const syncBrowserTimezone = createServerFn({ method: "POST" })
  .validator(z.object({ timezone: z.string() }))
  .handler(async ({ data }) => {
    const result = await updateProfile(
      database(),
      (await requireUser()).id,
      { timezone: data.timezone },
      "browser",
    );
    return { updated: result.ok && result.changed.length > 0 };
  });

/**
 * Deletes the signed-in user's account (docs/design.md §13): the typed
 * confirmation must match, then deletion starts and they're signed out.
 */
export const deleteAccount = createServerFn({ method: "POST" })
  .validator(z.object({ confirmation: z.literal("delete") }))
  .handler(async () => {
    await requestAccountDeletion(database(), (await requireUser()).id);
    await endSession();
    return { deleted: true };
  });
