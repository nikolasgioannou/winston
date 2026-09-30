import { createServerFn } from "@tanstack/react-start";
import { updateProfile } from "@winston/db/profile";
import { z } from "zod";
import { database } from "./db.server";
import { requireUser } from "./session.server";
import { telegramLinkOf } from "./telegram.server";

/** `/profile`'s loader. */
export const getProfileState = createServerFn({ method: "GET" }).handler(
  async () => {
    const user = await requireUser();
    return {
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      timezone: user.timezone,
      telegram: await telegramLinkOf(database(), user.id),
    };
  },
);

/** Saves the profile form: names and time zone, through the one shared path. */
export const saveProfile = createServerFn({ method: "POST" })
  .validator(
    z.object({
      firstName: z.string().optional(),
      lastName: z.string().optional(),
      timezone: z.string().optional(),
    }),
  )
  .handler(async ({ data }) =>
    updateProfile(
      database(),
      (await requireUser()).id,
      {
        ...(data.firstName !== undefined ? { firstName: data.firstName } : {}),
        ...(data.lastName !== undefined ? { lastName: data.lastName } : {}),
        ...(data.timezone !== undefined ? { timezone: data.timezone } : {}),
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
