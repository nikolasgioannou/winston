/**
 * The VM-facing API's errors (docs/design.md §11, §15): always
 * `{ error: { code, message, hint } }`, from this fixed set. The CLI maps
 * each code to its exit code, and every message says what to do next.
 */
export const apiErrors = {
  invalid_request: { status: 400, exitCode: 1 },
  unauthorized: { status: 401, exitCode: 1 },
  not_found: { status: 404, exitCode: 2 },
  permission_disabled: { status: 403, exitCode: 3 },
  auth_expired: { status: 401, exitCode: 4 },
  unavailable: { status: 503, exitCode: 5 },
  internal: { status: 500, exitCode: 5 },
  conflict: { status: 409, exitCode: 6 },
  not_supported: { status: 422, exitCode: 7 },
} as const;

export type ApiErrorCode = keyof typeof apiErrors;

export interface ApiErrorBody {
  error: { code: ApiErrorCode; message: string; hint: string | null };
}

export function apiError(
  code: ApiErrorCode,
  message: string,
  hint: string | null = null,
): ApiErrorBody {
  return { error: { code, message, hint } };
}
