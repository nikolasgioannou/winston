/**
 * The connector machinery every mail and calendar route goes through
 * (docs/design.md §5 Permissions, §11): which connection `--account` means,
 * and whether it may do what's asked. Permissions are checked here, on the
 * server, on every call; the prompt never decides.
 */
import type { DbOrTx } from "@winston/db/client";
import { connections } from "@winston/db/schema";
import {
  apiError,
  apiErrors,
  type ApiErrorBody,
  type ApiErrorCode,
} from "@winston/domain/api-errors";
import {
  unavailableCapabilities,
  type Capability,
  type ConnectionDomain,
} from "@winston/domain/connections";
import { ConnectionUnavailableError } from "@winston/connectors/access-token";
import type { CalendarProvider } from "@winston/connectors/calendar";
import {
  NotSupportedError,
  ProviderNotFoundError,
  ProviderUnavailableError,
} from "@winston/connectors/errors";
import type { MailReader } from "@winston/connectors/mail";
import { TimeParseError } from "@winston/shared/human-time";
import { and, asc, eq, ne } from "drizzle-orm";

export type ConnectionRow = typeof connections.$inferSelect;

export class ApiFailure extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly hint: string | null = null,
  ) {
    super(message);
  }
  get status() {
    return apiErrors[this.code].status;
  }
  get body(): ApiErrorBody {
    return apiError(this.code, this.message, this.hint);
  }
}

const domainName = { mail: "mail", calendar: "calendar" } as const;

/** Links into the site for fixing a connection. */
export function accountLinks(webPublicUrl: string, connectionId: string) {
  return {
    settings: new URL(`/accounts?account=${connectionId}`, webPublicUrl).href,
    reconnect: new URL(
      `/auth/google/connect?reconnect=${connectionId}`,
      webPublicUrl,
    ).href,
  };
}

/**
 * The connection `--account` names (its address or `acct_` id) for a domain.
 * Without the flag, the user's only connection for that domain. Disconnected
 * connections don't count. Throws `ApiFailure` with the choices otherwise.
 */
export async function resolveConnection(
  db: DbOrTx,
  userId: string,
  domain: ConnectionDomain,
  account: string | undefined,
): Promise<ConnectionRow> {
  const candidates = await db
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.userId, userId),
        eq(connections.domain, domain),
        ne(connections.status, "disconnected"),
      ),
    )
    .orderBy(asc(connections.createdAt), asc(connections.externalEmail));
  const choices = candidates.map((c) => c.externalEmail).join(", ");
  if (candidates.length === 0)
    throw new ApiFailure(
      "not_found",
      `There's no connected ${domainName[domain]} account.`,
      "The user can connect one at runwinston.com/accounts.",
    );
  if (account === undefined) {
    const [only] = candidates;
    if (candidates.length === 1 && only) return only;
    throw new ApiFailure(
      "invalid_request",
      `There are ${String(candidates.length)} ${domainName[domain]} accounts: ${choices}.`,
      "Say which with --account <email>.",
    );
  }
  const wanted = account.trim().toLowerCase();
  const match = candidates.find(
    (c) => c.id === wanted || c.externalEmail === wanted,
  );
  if (!match)
    throw new ApiFailure(
      "not_found",
      `No connected ${domainName[domain]} account is ${account}.`,
      `Use one of: ${choices}.`,
    );
  return match;
}

/**
 * Throws unless the connection may do `capability` now: it must not have
 * expired, and the user must have the capability switched on (and Google
 * must have granted its scope).
 */
export function requireCapability(
  connection: ConnectionRow,
  capability: Capability,
  webPublicUrl: string,
) {
  const links = accountLinks(webPublicUrl, connection.id);
  if (connection.status === "expired" || connection.status === "disconnected")
    throw new ApiFailure(
      "auth_expired",
      `Access to ${connection.externalEmail} has expired.`,
      `The user can reconnect it with one tap: ${links.reconnect}`,
    );
  if (
    unavailableCapabilities(
      connection.provider,
      connection.domain,
      connection.scopes,
    ).includes(capability)
  )
    throw new ApiFailure(
      "permission_disabled",
      `${connection.externalEmail} wasn't granted ${describe[capability]} on Google's screen.`,
      `The user can reconnect it and allow it: ${links.reconnect}`,
    );
  if (connection.capabilities[capability] !== true)
    throw new ApiFailure(
      "permission_disabled",
      `${capitalize(describe[capability])} is turned off for ${connection.externalEmail}.`,
      `The user can turn it on at ${links.settings}`,
    );
}

/** Each capability, as an error message says it. */
const describe: Record<Capability, string> = {
  read: "reading",
  draft: "drafting",
  send: "sending",
  modify_labels: "organizing mail",
  create: "creating events",
  update: "changing events",
  delete: "deleting events",
  rsvp: "answering invitations",
};

const capitalize = (text: string) =>
  text.charAt(0).toUpperCase() + text.slice(1);

/** What the connector routes need: providers per connection, and the site's address for links. */
export interface ConnectorDeps {
  webPublicUrl: string;
  mail: (connection: ConnectionRow) => MailReader;
  /** Absent until Google Calendar is wired (M5). */
  calendar?: (connection: ConnectionRow) => CalendarProvider;
}

/**
 * The API error a connector failure becomes, or undefined for anything
 * unexpected (a 500): unsupported operations are `not_supported` (exit 7),
 * a grant that lapsed mid-call is `auth_expired` (exit 4), and an id the
 * provider doesn't know is `not_found` (exit 2).
 */
export function toApiFailure(
  error: unknown,
  webPublicUrl: string | undefined,
): ApiFailure | undefined {
  if (error instanceof ApiFailure) return error;
  if (error instanceof NotSupportedError)
    return new ApiFailure("not_supported", error.message, error.hint);
  if (error instanceof ProviderNotFoundError)
    return new ApiFailure(
      "not_found",
      error.message,
      "Check the id: list or search to find it again.",
    );
  if (error instanceof TimeParseError)
    return new ApiFailure("invalid_request", error.message, error.hint);
  if (error instanceof ProviderUnavailableError)
    return new ApiFailure(
      "unavailable",
      error.message,
      "Try again in a minute.",
    );
  if (error instanceof ConnectionUnavailableError)
    return new ApiFailure(
      "auth_expired",
      "Access to this account has expired.",
      webPublicUrl
        ? `The user can reconnect it with one tap: ${accountLinks(webPublicUrl, error.connectionId).reconnect}`
        : "The user can reconnect it on runwinston.com/accounts.",
    );
  return undefined;
}
