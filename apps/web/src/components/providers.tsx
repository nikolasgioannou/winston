import {
  connectPath,
  type ConnectionDomain,
  type ConnectionProvider,
} from "@winston/domain/connections";
import { GmailIcon, GoogleCalendarIcon } from "@winston/ui";
import { Receipt } from "lucide-react";
import type { ReactNode } from "react";

/** Each domain's name, as the type badge shows it. */
export const domainNames: Record<ConnectionDomain, string> = {
  mail: "Mail",
  calendar: "Calendar",
  ramp: "Spend",
};

export const providerNames: Record<ConnectionProvider, string> = {
  gmail: "Gmail",
  google_calendar: "Google Calendar",
  winston: "Winston",
  ramp: "Ramp",
};

/** Each provider's brand icon (see the note on `GmailIcon` about Google's permission). */
const providerIcons: Record<ConnectionProvider, () => ReactNode> = {
  gmail: () => <GmailIcon />,
  google_calendar: () => <GoogleCalendarIcon />,
  // Winston's own mailbox is never listed with the user's accounts.
  winston: () => null,
  // A plain receipt until Ramp's mark is cleared for use (0bfa49): Ramp
  // publishes no brand kit to take it from.
  ramp: () => <Receipt size={16} aria-hidden />,
};

export function ProviderIcon({ provider }: { provider: ConnectionProvider }) {
  return providerIcons[provider]();
}

/**
 * What the user can connect, grouped by domain: the Add account dialog lists
 * this, so a new provider is one entry here (and its connect flow).
 */
export const connectableProviders: {
  domain: ConnectionDomain;
  providers: { provider: ConnectionProvider; href: string }[];
}[] = [
  {
    domain: "mail",
    providers: [{ provider: "gmail", href: connectPath("mail") }],
  },
  {
    domain: "calendar",
    providers: [{ provider: "google_calendar", href: connectPath("calendar") }],
  },
  {
    domain: "ramp",
    providers: [{ provider: "ramp", href: connectPath("ramp") }],
  },
];
