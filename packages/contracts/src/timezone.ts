import { z } from "zod";

export function validTimezone(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 100 || /^[+-]/.test(value)) {
    return false;
  }

  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(0);

    return true;
  } catch {
    return false;
  }
}

export const timezoneProfileSchema = z.object({
  timezone: z.string().refine(validTimezone),
  revision: z.number().int().nonnegative(),
  observedAt: z.iso.datetime().nullable(),
  source: z.enum(["default", "browser"]),
});

export type TimezoneProfile = z.infer<typeof timezoneProfileSchema>;

export const timezoneUpdateSchema = z
  .object({
    timezone: z.string().max(100).optional(),
    revision: z.number().int().nonnegative(),
  })
  .strict();

// Store this snapshot with a new message; never reformat history using a later profile.
export function timestampSnapshot(instant: Date, timezone: string) {
  if (!validTimezone(timezone)) {
    throw new Error("A valid timezone is required for a timestamp snapshot.");
  }

  const offset = new Intl.DateTimeFormat("en", {
    timeZone: timezone,
    timeZoneName: "longOffset",
  })
    .formatToParts(instant)
    .find((part) => part.type === "timeZoneName")?.value;

  if (!offset) {
    throw new Error("Timezone offset is unavailable.");
  }

  return {
    instant: instant.toISOString(),
    timezone,
    offset: offset === "GMT" ? "+00:00" : offset.replace("GMT", ""),
  };
}
