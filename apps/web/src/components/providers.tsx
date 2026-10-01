import type {
  ConnectionDomain,
  ConnectionProvider,
} from "@winston/domain/connections";
import { CalendarDays, Mail } from "lucide-react";

/** Each domain's name, as the type badge shows it. */
export const domainNames: Record<ConnectionDomain, string> = {
  mail: "Mail",
  calendar: "Calendar",
};

export const providerNames: Record<ConnectionProvider, string> = {
  gmail: "Gmail",
  google_calendar: "Google Calendar",
};

/**
 * A provider's icon. Google requires permission to show its product icons
 * (Partner Marketing Hub), so Gmail and Google Calendar show neutral icons
 * until it's granted; their brand icons go here, the one place to change.
 */
export function ProviderIcon({ provider }: { provider: ConnectionProvider }) {
  return provider === "gmail" ? <Mail /> : <CalendarDays />;
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
    providers: [
      { provider: "gmail", href: "/auth/google/connect?domain=mail" },
    ],
  },
  {
    domain: "calendar",
    providers: [
      {
        provider: "google_calendar",
        href: "/auth/google/connect?domain=calendar",
      },
    ],
  },
];
