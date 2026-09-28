import { apiErrors, type ApiErrorCode } from "@winston/domain/api-errors";

/**
 * A failure with its exit code (§11: 0 ok, 1 usage, 2 not found, 3 permission
 * disabled, 4 auth expired, 5 transient, 6 conflict, 7 not supported) and a
 * message that says what to do next.
 */
export class CliError extends Error {
  constructor(
    readonly exitCode: number,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
  }

  static usage(message: string, hint?: string) {
    return new CliError(1, message, hint);
  }

  /** From the backend's `{ error: { code, message, hint } }`. */
  static fromApi(code: string, message: string, hint: string | null) {
    const known = apiErrors[code as ApiErrorCode] as
      { exitCode: number } | undefined;
    return new CliError(known?.exitCode ?? 5, message, hint ?? undefined);
  }
}
