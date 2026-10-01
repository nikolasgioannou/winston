import { canonicalTimeZone } from "@winston/shared/time";
import { nextFireAt } from "@winston/domain/triggers";
import { and, eq, isNotNull, isNull, ne, or } from "drizzle-orm";
import type { DbOrTx } from "./client.ts";
import { triggers, users } from "./schema/index.ts";
import { recordSystemEvent } from "./system-events.ts";

/** The profile fields a user (or Winston, for the time zone) can change. */
export interface ProfileChanges {
  firstName?: string;
  lastName?: string;
  timezone?: string;
}

/** Who made a change: the user on the site, their browser's time zone, or Winston through the CLI. */
export type ProfileChangeSource = "site" | "browser" | "winston";

export type ProfileUpdateResult =
  | { ok: true; changed: (keyof ProfileChanges)[] }
  | { ok: false; problem: "invalid_timezone" | "invalid_name" | "not_found" };

const columnNames: Record<keyof ProfileChanges, string> = {
  firstName: "first_name",
  lastName: "last_name",
  timezone: "timezone",
};

/**
 * Changes a user's profile: the one path for the site, the browser's time
 * zone and the CLI (docs/design.md §20). Time zones are validated and stored
 * by their canonical IANA name, names are trimmed and must not be empty.
 * Each field that actually changes records `system.settings.changed`
 * (field, old, new and who changed it), so Winston knows; an unchanged value
 * records nothing.
 */
export async function updateProfile(
  db: DbOrTx,
  userId: string,
  changes: ProfileChanges,
  source: ProfileChangeSource,
): Promise<ProfileUpdateResult> {
  const next: ProfileChanges = {};
  if (changes.timezone !== undefined) {
    const zone = canonicalTimeZone(changes.timezone);
    if (!zone) return { ok: false, problem: "invalid_timezone" };
    next.timezone = zone;
  }
  for (const field of ["firstName", "lastName"] as const) {
    const value = changes[field]?.trim();
    if (value === undefined) continue;
    // A last name may be blank (Google doesn't always have one); a first name can't.
    if ((field === "firstName" && value === "") || value.length > 100)
      return { ok: false, problem: "invalid_name" };
    next[field] = value;
  }

  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({
        firstName: users.firstName,
        lastName: users.lastName,
        timezone: users.timezone,
      })
      .from(users)
      .where(eq(users.id, userId))
      .for("update");
    if (!current) return { ok: false, problem: "not_found" };
    const changed = (Object.keys(next) as (keyof ProfileChanges)[]).filter(
      (field) => next[field] !== current[field],
    );
    if (changed.length === 0) return { ok: true, changed };

    await tx
      .update(users)
      .set(Object.fromEntries(changed.map((field) => [field, next[field]])))
      .where(eq(users.id, userId));
    // Recurring schedules keep their local time in the new zone (§3, §20).
    if (next.timezone && changed.includes("timezone"))
      await rescheduleCron(tx, userId, next.timezone);
    const at = String(Date.now());
    for (const field of changed)
      await recordSystemEvent(tx, {
        userId,
        type: "system.settings.changed",
        payload: {
          field: columnNames[field],
          old: current[field],
          new: next[field],
          source,
        },
        sourceRef: `user:${userId}:settings:${field}:${at}`,
      });
    return { ok: true, changed };
  });
}

/**
 * Follows the device: adopts the browser's zone only when it differs from the
 * one the browser last reported, so a zone Winston set ("I'm in Tokyo this
 * week") isn't undone by a laptop still on home time, yet travelling with the
 * device still moves it (docs/design.md §20). Returns whether the user's zone
 * changed.
 */
export async function followBrowserTimezone(
  db: DbOrTx,
  userId: string,
  browserTimezone: string,
): Promise<{ updated: boolean }> {
  const zone = canonicalTimeZone(browserTimezone);
  if (!zone) return { updated: false };
  const [moved] = await db
    .update(users)
    .set({ browserTimezone: zone })
    .where(
      and(
        eq(users.id, userId),
        or(isNull(users.browserTimezone), ne(users.browserTimezone, zone)),
      ),
    )
    .returning({ id: users.id });
  if (!moved) return { updated: false };
  const result = await updateProfile(db, userId, { timezone: zone }, "browser");
  return { updated: result.ok && result.changed.length > 0 };
}

/**
 * Recomputes each active cron schedule's next time in the user's new zone:
 * "9am every weekday" follows them to London. One-off times are instants
 * and stay put.
 */
async function rescheduleCron(db: DbOrTx, userId: string, timeZone: string) {
  const schedules = await db
    .select()
    .from(triggers)
    .where(
      and(
        eq(triggers.userId, userId),
        eq(triggers.kind, "schedule"),
        eq(triggers.status, "active"),
        isNotNull(triggers.cron),
      ),
    );
  const now = new Date();
  for (const schedule of schedules)
    await db
      .update(triggers)
      .set({ nextFireAt: nextFireAt(schedule, now, timeZone) })
      .where(eq(triggers.id, schedule.id));
}
