/** A linked Telegram chat, as the site shows it. */
export interface TelegramLinkState {
  /** The Telegram @username, if the user has one. */
  username: string | null;
  /** The account's display name (first and last name). */
  displayName: string | null;
  /** When it was linked; a relink changes it. */
  linkedAt: string;
}

/** A one-time link that opens the bot and links the chat (docs/design.md §9). */
export interface TelegramDeepLink {
  url: string;
  expiresAt: string;
}
