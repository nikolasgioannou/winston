/**
 * The CLI's only way out (docs/design.md §15): HTTP to winstond's unix
 * socket, typed end to end with the VM-facing API's Hono RPC types, and
 * carrying the run token from the environment.
 */
import type { ApiErrorBody } from "@winston/domain/api-errors";
import type { VmApi } from "@winston/vm-api";
import { hc } from "hono/client";
import { CliError } from "./errors.ts";

export const defaultSocketPath = "/run/winstond/winstond.sock";

export function apiClient(options: {
  socketPath: string;
  runToken: string | undefined;
  /** For tests: stands in for the socket. */
  fetch?: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
}) {
  const transport =
    options.fetch ??
    ((input: string | URL | Request, init?: RequestInit) =>
      fetch(input, { ...init, unix: options.socketPath }));
  return hc<VmApi>("http://winstond", {
    fetch: transport,
    headers: options.runToken
      ? { Authorization: `Bearer ${options.runToken}` }
      : {},
  });
}

export type ApiClient = ReturnType<typeof apiClient>;

/**
 * Calls winstond answers itself rather than forwarding (the browser,
 * `@winston/domain/browser`): plain JSON over the same socket, with the
 * same run token.
 */
export function localClient(options: Parameters<typeof apiClient>[0]) {
  const transport =
    options.fetch ??
    ((input: string | URL | Request, init?: RequestInit) =>
      fetch(input, { ...init, unix: options.socketPath }));
  return {
    request(method: "GET" | "POST", path: string, body?: unknown) {
      return transport(`http://winstond${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(options.runToken
            ? { Authorization: `Bearer ${options.runToken}` }
            : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    },
  };
}

export type LocalClient = ReturnType<typeof localClient>;

/**
 * Awaits a call and returns its JSON, or throws the backend's error as a
 * CliError (with its exit code). A socket that can't be reached is a
 * transient failure (exit 5).
 */
/** What a call returns: a Hono RPC response, or anything shaped like one. */
interface ResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export async function call<T>(request: Promise<ResponseLike>): Promise<T> {
  let response: ResponseLike;
  try {
    response = await request;
  } catch {
    throw new CliError(
      5,
      "Can't reach winstond, the link to Winston's backend.",
      "Try again in a moment.",
    );
  }
  // Typed by the caller from the endpoint it called.
  if (response.ok) return (await response.json()) as T;
  const body = (await response.json().catch(() => undefined)) as
    ApiErrorBody | undefined;
  if (body?.error)
    throw CliError.fromApi(
      body.error.code,
      body.error.message,
      body.error.hint,
    );
  throw new CliError(
    5,
    `The backend answered ${String(response.status)}.`,
    "Try again in a moment.",
  );
}
