/**
 * An operation this account's provider can't do (docs/design.md §3, Handling
 * provider differences). The VM-facing API answers `not_supported` (exit 7)
 * with the hint, which should name the alternative.
 */
export class NotSupportedError extends Error {
  override name = "NotSupportedError";
  constructor(
    message: string,
    readonly hint: string | null = null,
  ) {
    super(message);
  }
}

/** Something the user named doesn't exist at the provider (exit 2). */
export class ProviderNotFoundError extends Error {
  override name = "ProviderNotFoundError";
}

/**
 * Sending was refused by our own rules: a limit was reached, or a recipient
 * bounced or complained before. Trying again won't help.
 */
export class SendingRefusedError extends Error {
  override name = "SendingRefusedError";
  constructor(
    message: string,
    readonly hint: string | null,
    readonly reason: "limit" | "suppressed",
  ) {
    super(message);
  }
}

/** The provider is rate-limiting or down; trying again later is safe (exit 5). */
export class ProviderUnavailableError extends Error {
  override name = "ProviderUnavailableError";
}
