import {
  index,
  integer,
  jsonb,
  pgEnum,
  snakeCase,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { newId } from "../ids.ts";
import { runs } from "./runs.ts";
import { users } from "./users.ts";

/** Whether Winston kept what Jev picked (docs/design.md §5, Jev fast path). */
export const jevOutcome = pgEnum("jev_outcome", [
  "verified",
  "overridden",
  "unknown",
]);

/**
 * One call to Jev (docs/design.md §5, §14): the typed questions asked about
 * a page, the answers with their probabilities, and how long it took. A
 * failed call keeps its `error` and no answer. The action taken and its
 * outcome are filled in by the caller afterwards (autopilot), and per-site
 * reliability is a query over them.
 */
export const jevDecisions = snakeCase.table(
  "jev_decisions",
  {
    id: text()
      .primaryKey()
      .$default(() => newId("jevDecision")),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    runId: text().references(() => runs.id, { onDelete: "set null" }),
    /** The site's registrable domain (eTLD+1), when the caller says. */
    domain: text(),
    /** The request as sent: `{ state, questions }`. */
    question: jsonb().notNull(),
    answer: jsonb(),
    /** The model that answered, e.g. `typesafe/jev-1.13-20260917`. */
    model: text(),
    error: text(),
    action: text(),
    outcome: jevOutcome().notNull().default("unknown"),
    latencyMs: integer().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.domain, t.createdAt), index().on(t.runId)],
);
