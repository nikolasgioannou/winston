/**
 * Winston's own mailbox (docs/design.md §5 Connections): the address the
 * user picks for him, `<name>@runwinston.email`. An address belongs to the
 * user who took it for good, so these rules decide what may be taken, never
 * what may be given back.
 */

/** His mail's domain, apart from the site's and deployed apps' (ead827). */
export const mailboxDomain = "runwinston.email";

/** How many times a user may change the address after picking it. */
export const maxAddressChanges = 2;

/**
 * Names nobody may take: the role addresses mail standards and providers
 * expect (RFC 2142 and the like), and ones that could pass for us.
 */
export const reservedMailboxNames: ReadonlySet<string> = new Set([
  "abuse",
  "admin",
  "administrator",
  "billing",
  "help",
  "hostmaster",
  "info",
  "mailer-daemon",
  "no-reply",
  "noc",
  "noreply",
  "postmaster",
  "root",
  "security",
  "support",
  "team",
  "webmaster",
  "winston",
]);

export type MailboxNameProblem =
  | "too_short"
  | "too_long"
  | "invalid_characters"
  | "bad_punctuation"
  | "reserved";

/** What each problem tells the user. */
export const mailboxNameProblemText: Record<MailboxNameProblem, string> = {
  too_short: "Use at least 3 characters.",
  too_long: "Use at most 30 characters.",
  invalid_characters: "Use only letters, numbers, dots and hyphens.",
  bad_punctuation:
    "Start and end with a letter or number, with no two dots or hyphens in a row.",
  reserved: "That name is reserved.",
};

/** A name as the user typed it, as it's stored: trimmed and lowercase. */
export const normalizeMailboxName = (name: string) => name.trim().toLowerCase();

/** Why `name` (normalized) can't be an address, or undefined if it can. */
export function mailboxNameProblem(
  name: string,
): MailboxNameProblem | undefined {
  if (name.length < 3) return "too_short";
  if (name.length > 30) return "too_long";
  if (!/^[a-z0-9.-]+$/.test(name)) return "invalid_characters";
  if (
    !/^[a-z0-9]/.test(name) ||
    !/[a-z0-9]$/.test(name) ||
    /[.-]{2}/.test(name)
  )
    return "bad_punctuation";
  if (reservedMailboxNames.has(name)) return "reserved";
  return undefined;
}

/** The full address for a (valid) name. */
export const mailboxAddress = (name: string) => `${name}@${mailboxDomain}`;
