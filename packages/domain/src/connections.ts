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

const personalEmailDomains = new Set(["gmail.com", "googlemail.com"]);

/**
 * A new connection's alias, unique among the user's connections in that
 * domain (Winston says `--account work`): "personal" for a Gmail address,
 * "work" otherwise; if that's taken, the company (or, for Gmail, the
 * address's name), then numbered.
 */
export function defaultAlias(email: string, taken: ReadonlySet<string>) {
  const [local = "", host = ""] = email.toLowerCase().split("@");
  const personal = personalEmailDomains.has(host);
  const base = personal ? "personal" : "work";
  const second = personal ? local : (host.split(".")[0] ?? "");
  for (const alias of [base, second])
    if (alias !== "" && !taken.has(alias)) return alias;
  for (let n = 2; ; n++) {
    const alias = `${base}-${String(n)}`;
    if (!taken.has(alias)) return alias;
  }
}
