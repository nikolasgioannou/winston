/**
 * `winston accounts` (docs/design.md §11, §3 capability discovery): the
 * user's connected accounts, and for one account what Winston may do with it
 * (each capability on, off, or never granted on Google's screen), its
 * calendars, and what's particular to its provider.
 */
import type { CalendarInfo } from "@winston/connectors/calendar";
import type { DbOrTx } from "@winston/db/client";
import { googleBacked } from "@winston/db/connections";
import { mailboxState } from "@winston/db/mailbox";
import { connections } from "@winston/db/schema";
import {
  capabilitiesByDomain,
  connectionDomains,
  unavailableCapabilities,
  type ConnectionProvider,
} from "@winston/domain/connections";
import { and, asc, eq, ne, or } from "drizzle-orm";
import { Hono } from "hono";
import {
  accountLinks,
  ApiFailure,
  connectLink,
  describe,
  type ConnectionRow,
  type ConnectorDeps,
} from "./connections.ts";
import type { VmApiEnv } from "./env.ts";

/** What's particular to each provider, for an agent deciding how to use it. */
export const providerNotes: Record<ConnectionProvider, string[]> = {
  gmail: [
    'Search with Gmail\'s own syntax through --native, e.g. --native "from:dana has:attachment older_than:1y".',
    "Labels are Gmail labels; adding one that doesn't exist creates it.",
    "Delete moves mail to the trash, which Gmail empties after 30 days.",
    "Mail is sent from this address, under the name set in Gmail.",
  ],
  winston: [
    "Winston's own mailbox, at his own address, not the user's: mail here is to and from Winston.",
    "Mail commands use it only when it's named with --account.",
    "The user turns it on or off, or changes its address, at runwinston.com/channels.",
    "It can't be read or sent from yet.",
  ],
  google_calendar: [
    "Lists cover the calendars the user shows in Google Calendar; pick another with --calendar.",
    "--video adds a Google Meet link.",
    '--repeat takes an RRULE (FREQ=WEEKLY;BYDAY=TU). Changing "this and following" splits the series in two.',
    "People outside the account's organization often hide their free/busy; winston calendar free says whose it couldn't see.",
  ],
};

const summary = (c: ConnectionRow) => ({
  id: c.id,
  domain: c.domain,
  provider: c.provider,
  email: c.externalEmail,
  status: c.status,
});

export function accountRoutes({
  db,
  connectors,
}: {
  db: DbOrTx;
  connectors: ConnectorDeps | undefined;
}) {
  const connected = (userId: string) =>
    and(eq(connections.userId, userId), ne(connections.status, "disconnected"));

  /** The calendars on a calendar account, or why they aren't shown. */
  async function calendarsOf(connection: ConnectionRow): Promise<{
    calendars: CalendarInfo[] | null;
    calendarsNote: string | null;
  }> {
    if (connection.domain !== "calendar")
      return { calendars: null, calendarsNote: null };
    const why = (calendarsNote: string) => ({ calendars: null, calendarsNote });
    if (connection.status === "expired")
      return why("Access has expired, so the calendars can't be listed.");
    if (connection.capabilities.read !== true)
      return why("Reading is off, so the calendars aren't shown.");
    const calendar = connectors?.calendar;
    if (!calendar) return why("Calendars aren't available here.");
    try {
      return {
        calendars: await calendar(connection).listCalendars(),
        calendarsNote: null,
      };
    } catch (error) {
      return why(
        `Couldn't list the calendars: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return new Hono<VmApiEnv>()
    .get("/", async (c) => {
      const rows = await db
        .select()
        .from(connections)
        .where(connected(c.get("run").userId))
        .orderBy(
          asc(connections.domain),
          asc(connections.createdAt),
          asc(connections.externalEmail),
        );
      return c.json({ accounts: rows.map(summary) });
    })
    .get("/connect/:domain", async (c) => {
      const domain = connectionDomains.find((d) => d === c.req.param("domain"));
      if (!domain)
        throw new ApiFailure(
          "invalid_request",
          `There's no "${c.req.param("domain")}" to connect.`,
          `Connect ${connectionDomains.join(" or ")}.`,
        );
      if (!connectors)
        throw new ApiFailure(
          "unavailable",
          "Connecting accounts isn't available here.",
          null,
        );
      const rows = await db
        .select({ email: connections.externalEmail })
        .from(connections)
        .where(
          and(
            connected(c.get("run").userId),
            eq(connections.domain, domain),
            googleBacked,
          ),
        )
        .orderBy(asc(connections.externalEmail));
      // Winston's own address is set up on the site's Channels page.
      const mailbox =
        domain === "mail"
          ? await mailboxState(db, c.get("run").userId)
          : undefined;
      return c.json({
        domain,
        url: connectLink(connectors.webPublicUrl, domain),
        connected: rows.map((row) => row.email),
        winstonMailbox: mailbox
          ? {
              status: mailbox.status,
              address: mailbox.status === "never" ? null : mailbox.address,
              url: new URL(
                mailbox.status === "never"
                  ? "/channels?email=setup"
                  : "/channels",
                connectors.webPublicUrl,
              ).href,
            }
          : null,
      });
    })
    .get("/:id", async (c) => {
      const { userId } = c.get("run");
      const wanted = c.req.param("id").trim().toLowerCase();
      // An address can be both a mail and a calendar account; show both.
      const rows = await db
        .select()
        .from(connections)
        .where(
          and(
            connected(userId),
            or(
              eq(connections.id, wanted),
              eq(connections.externalEmail, wanted),
            ),
          ),
        )
        .orderBy(asc(connections.domain));
      if (rows.length === 0)
        throw new ApiFailure(
          "not_found",
          `No connected account is ${c.req.param("id")}.`,
          "winston accounts list shows them.",
        );
      const accounts = await Promise.all(
        rows.map(async (row) => {
          const ungranted = unavailableCapabilities(
            row.provider,
            row.domain,
            row.scopes,
          );
          return {
            ...summary(row),
            capabilities: capabilitiesByDomain[row.domain].map((name) => ({
              name,
              description: describe[name],
              on: row.capabilities[name] === true,
              granted: !ungranted.includes(name),
            })),
            ...(await calendarsOf(row)),
            notes: providerNotes[row.provider],
            /** Where the user changes permissions or reconnects (Google accounts only). */
            links:
              connectors && row.provider !== "winston"
                ? accountLinks(connectors.webPublicUrl, row.id)
                : null,
          };
        }),
      );
      return c.json({ accounts });
    });
}
