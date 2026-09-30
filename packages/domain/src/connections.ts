/**
 * Connected accounts' vocabulary (docs/design.md §3 Naming, §12a): domains,
 * never provider names, and each domain's capabilities, which the user
 * toggles per connection and the server enforces.
 */

export const connectionDomains = ["mail", "calendar"] as const;
export type ConnectionDomain = (typeof connectionDomains)[number];

/** Who serves a domain today; an attribute of the connection. */
export const connectionProviders = ["gmail", "google_calendar"] as const;
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
