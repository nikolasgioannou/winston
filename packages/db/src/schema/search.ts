import { sql, type SQL } from "drizzle-orm";
import { customType } from "drizzle-orm/pg-core";

/** A Postgres `tsvector`, for full-text search (history search, §2). */
export const tsvector = customType<{ data: string }>({
  dataType: () => "tsvector",
});

/**
 * What history search matches on, from a text expression: English stems
 * ("booked" finds "booking") plus the words as written, so names, emails and
 * order numbers match exactly too.
 */
export const searchable = (text: SQL) =>
  sql`to_tsvector('english'::regconfig, ${text}) || to_tsvector('simple'::regconfig, ${text})`;
