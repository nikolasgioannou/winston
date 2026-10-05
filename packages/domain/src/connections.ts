/**
 * Connected accounts' vocabulary (docs/design.md §3 Naming, §12a): domains,
 * never provider names, and each domain's capabilities, which the user
 * toggles per connection and the server enforces.
 */

export const connectionDomains = ["mail", "calendar"] as const;
export type ConnectionDomain = (typeof connectionDomains)[number];

/** Whether `value` names a connection domain (an event's domain may not). */
export const isConnectionDomain = (value: string): value is ConnectionDomain =>
  (connectionDomains as readonly string[]).includes(value);

/**
 * Who serves a connection; an attribute of the connection. `winston` is
 * Winston's own mailbox, which we serve ourselves.
 */
export const connectionProviders = [
  "gmail",
  "google_calendar",
  "winston",
] as const;
export type ConnectionProvider = (typeof connectionProviders)[number];

export const capabilitiesByDomain = {
  mail: ["read", "draft", "send", "modify_labels"],
  calendar: ["read", "create", "update", "delete", "rsvp"],
} as const satisfies Record<ConnectionDomain, readonly string[]>;

export type Capability<D extends ConnectionDomain = ConnectionDomain> =
  (typeof capabilitiesByDomain)[D][number];

/** Each capability of a connection's domain, on or off. */
export type CapabilityMap = Partial<Record<Capability, boolean>>;

/** Where a connection's grant stands (§12a: testing-mode grants expire in 7 days). */
export const connectionStatuses = [
  "ok",
  "expiring",
  "expired",
  "disconnected",
] as const;
export type ConnectionStatus = (typeof connectionStatuses)[number];

/**
 * What a new connection may do until the user changes it: read, and for
 * mail, draft. Anything that reaches other people or changes things starts
 * off (the founder's call, 2026-09-29).
 */
export const defaultCapabilities = {
  mail: { read: true, draft: true, send: false, modify_labels: false },
  calendar: {
    read: true,
    create: false,
    update: false,
    delete: false,
    rsvp: false,
  },
} as const satisfies Record<ConnectionDomain, CapabilityMap>;

/**
 * The Google scope each capability needs, per provider. The connect flow asks
 * for every scope a domain uses, but the user can untick some on Google's
 * screen; a capability whose scope is missing is unavailable until they
 * reconnect.
 */
export const capabilityScopes = {
  gmail: {
    read: "gmail.modify",
    draft: "gmail.modify",
    send: "gmail.modify",
    modify_labels: "gmail.modify",
  },
  google_calendar: {
    read: "calendar.events",
    create: "calendar.events",
    update: "calendar.events",
    delete: "calendar.events",
    rsvp: "calendar.events",
  },
} as const satisfies {
  gmail: Record<Capability<"mail">, string>;
  google_calendar: Record<Capability<"calendar">, string>;
};

/**
 * Every capability of Winston's own mailbox is on, with no switches: limits
 * on it are the server's (ead827).
 */
export const winstonMailboxCapabilities = {
  read: true,
  draft: true,
  send: true,
  modify_labels: true,
} as const satisfies CapabilityMap;

/** The provider the user connects for each domain. */
export const providerOf = {
  mail: "gmail",
  calendar: "google_calendar",
} as const satisfies Record<ConnectionDomain, ConnectionProvider>;

/**
 * Who issues a connection's token, which decides how it's connected,
 * refreshed, expired and revoked. Mail and calendar share one Google OAuth
 * client, so their grants share Google's screen and its revocation.
 */
export const tokenIssuers = ["google"] as const;
export type TokenIssuer = (typeof tokenIssuers)[number];

/**
 * How each provider's connections behave (74641a): who issued their token
 * (none for Winston's own mailbox, whose mail is pushed to us), and whether
 * Winston syncs the account's changes and keeps a push watch on them.
 */
export const providerTraits = {
  gmail: { issuer: "google", syncs: true },
  google_calendar: { issuer: "google", syncs: true },
  winston: { issuer: null, syncs: false },
} as const satisfies Record<
  ConnectionProvider,
  { issuer: TokenIssuer | null; syncs: boolean }
>;

/** The providers whose tokens `issuer` issues. */
export const providersIssuedBy = (issuer: TokenIssuer) =>
  connectionProviders.filter(
    (provider) => providerTraits[provider].issuer === issuer,
  );

/** The providers whose accounts Winston syncs and watches. */
export const syncedProviders = connectionProviders.filter(
  (provider) => providerTraits[provider].syncs,
);

/** Each issuer as the user knows it, from its sign-in screen. */
export const issuerNames: Record<TokenIssuer, string> = { google: "Google" };

/** Whose sign-in screen grants a provider's scopes ("Google"). */
export function issuerOf(provider: ConnectionProvider) {
  const issuer = providerTraits[provider].issuer;
  return issuer ? issuerNames[issuer] : "the provider";
}

/** Where the site starts connecting an account with each issuer. */
const connectPaths: Record<TokenIssuer, string> = {
  google: "/auth/google/connect",
};

/** The site's path that starts connecting a new account for `domain`. */
export function connectPath(domain: ConnectionDomain) {
  const issuer = providerTraits[providerOf[domain]].issuer;
  return `${connectPaths[issuer]}?domain=${domain}`;
}

/**
 * The site's path that reconnects a connection with one tap, or null for one
 * with no token to renew (Winston's own mailbox).
 */
export function reconnectPath(connection: {
  id: string;
  provider: ConnectionProvider;
}) {
  const issuer = providerTraits[connection.provider].issuer;
  return issuer && `${connectPaths[issuer]}?reconnect=${connection.id}`;
}

/** Whether `capability` is one of `domain`'s. */
export function isCapabilityOf<D extends ConnectionDomain>(
  domain: D,
  capability: string,
): capability is Capability<D> {
  return (capabilitiesByDomain[domain] as readonly string[]).includes(
    capability,
  );
}

/**
 * A connection's capabilities whose Google scope wasn't granted: unusable
 * until it's reconnected. Winston's own mailbox has no grant to lack.
 */
export function unavailableCapabilities(
  provider: ConnectionProvider,
  domain: ConnectionDomain,
  scopes: readonly string[],
): Capability[] {
  if (provider === "winston") return [];
  const needed: Record<string, string> = capabilityScopes[provider];
  return capabilitiesByDomain[domain].filter(
    (capability) => !scopes.includes(needed[capability] ?? ""),
  );
}
