/**
 * Output (§11): compact, agent-readable text by default, one line per record
 * starting with its id; `--json` when asked. Always bounded, with a footer
 * that says how to get more.
 */
import { formatInTimeZone } from "@winston/shared/time";

export const defaultLimit = 20;

/** A time in the user's time zone, with its offset. */
export const time = (date: Date | string, timeZone: string) =>
  formatInTimeZone(typeof date === "string" ? new Date(date) : date, timeZone);

/** A time for list lines: `2026-09-25 16:02 -04:00`, in the user's zone. */
export const shortTime = (date: Date | string, timeZone: string) =>
  time(date, timeZone).replace(
    /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}):\d{2}(.*)$/,
    "$1 $2 $3",
  );

/** One record: its id, then its most useful fields, separated by " · ". */
export const record = (id: string, ...fields: (string | undefined | null)[]) =>
  [id, ...fields.filter((field): field is string => Boolean(field))].join(
    " · ",
  );

/**
 * A bounded list: at most `limit` lines, then a footer if there's more, naming
 * the cursor and a way to narrow down.
 */
export function list(
  lines: readonly string[],
  options: {
    limit?: number;
    more?: number;
    nextCursor?: string;
    narrow?: string;
  } = {},
) {
  const limit = options.limit ?? defaultLimit;
  const shown = lines.slice(0, limit);
  const hidden = (options.more ?? 0) + Math.max(0, lines.length - limit);
  const out = shown.length > 0 ? [...shown] : ["Nothing found."];
  if (hidden > 0 || options.nextCursor) {
    const ways = [
      options.nextCursor ? `use --cursor ${options.nextCursor}` : undefined,
      options.narrow ? `narrow with ${options.narrow}` : undefined,
    ].filter(Boolean);
    out.push(
      `… ${hidden > 0 ? `${String(hidden)} more` : "more"}.${ways.length > 0 ? ` To see them, ${ways.join(" or ")}.` : ""}`,
    );
  }
  return out.join("\n");
}

/** Deterministic JSON: stable key order, two-space indent. */
export const json = (value: unknown) =>
  JSON.stringify(
    value,
    (_key, nested: unknown) =>
      nested !== null && typeof nested === "object" && !Array.isArray(nested)
        ? Object.fromEntries(
            Object.entries(nested).sort(([a], [b]) =>
              a < b ? -1 : a > b ? 1 : 0,
            ),
          )
        : nested,
    2,
  );
