import type { ComputerStatus } from "@winston/db/vms";

/**
 * Everything `/home` shows, from one loader (docs/design.md §20). Later
 * tickets fill in their parts: Telegram linking, connected accounts and the
 * attention items (expiring access, from the token lifecycle).
 */
export interface HomeState {
  firstName: string;
  /** Null only if the user has no computer, which sign-up prevents. */
  computer: ComputerStatus | null;
  telegramLinked: boolean;
  /** Connected Google accounts, not counting disconnected ones. */
  accountsConnected: number;
  /** Things that need the user, most urgent first: expired accounts, then expiring ones. */
  attention: AttentionItem[];
}

/** Something the user should act on, like an account whose access is expiring. */
export interface AttentionItem {
  id: string;
  tone: "attention" | "error";
  title: string;
  description: string;
  /** A full-page link, since some (like reconnecting) are server routes. */
  action?: { label: string; href: string };
}
