import type { ResolvedTarget } from "@winston/contracts/connection-targets";
import type { AuthorizationRequest } from "@winston/contracts/authorization";
import type { createDatabase } from "../database";
import type { GoogleConnections } from "./index";
import { createConnectionTargets } from "./targets";
import { sameResolvedTarget } from "./target-resolution";

export type GoogleReadFailure =
  "denied" | "approval_required" | "stale" | "unavailable" | "too_large";
export class GoogleReadError extends Error {
  constructor(
    readonly kind: GoogleReadFailure,
    service: string,
  ) {
    super(`${service} read ${kind}.`);
  }
}
export type GoogleReadOptions = {
  approved?: (request: AuthorizationRequest) => Promise<boolean>;
  authorize?: () => Promise<boolean>;
  database: ReturnType<typeof createDatabase>;
  google: Pick<GoogleConnections, "list" | "calendars" | "access" | "rejected">;
  fetch?: (url: URL, init: RequestInit) => Promise<Response>;
};

async function boundedJson(
  response: Response,
  limit: number,
  fail: (kind: GoogleReadFailure) => GoogleReadError,
) {
  if (!response.body) throw fail("unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size <= limit) {
      const next = await reader.read();
      if (next.done) break;
      const chunk: unknown = next.value;
      if (!(chunk instanceof Uint8Array)) throw fail("unavailable");
      size += chunk.length;
      if (size > limit) throw fail("too_large");
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createGoogleReadRequest(
  options: GoogleReadOptions,
  config: {
    service: "gmail" | "calendar";
    error: (kind: GoogleReadFailure) => GoogleReadError;
  },
) {
  const { database, google } = options;
  const targets = createConnectionTargets(database, google);
  const operation = config.service === "gmail" ? "gmail.read" : "calendar.read";
  const base =
    config.service === "gmail"
      ? "https://gmail.googleapis.com/gmail/v1/users/me/"
      : "https://www.googleapis.com/calendar/v3/";
  const limit = (config.service === "gmail" ? 40 : 8) * 1024 * 1024;
  const fail = config.error;

  return async (
    ownerId: string,
    target: ResolvedTarget,
    path: string,
    query: URLSearchParams,
    signal: AbortSignal,
  ) => {
    try {
      if (options.authorize && !(await options.authorize())) throw fail("stale");
      if (
        target.operation !== operation ||
        (config.service === "gmail" ? target.calendarId !== null : !target.calendarId)
      )
        throw fail("stale");
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
      const selected = await targets.resolve(
        ownerId,
        {
          operation,
          explicit: { connectionId: target.connectionId, calendarId: target.calendarId },
          ...(target.task ? { task: target.task } : {}),
        },
        deadline,
      );
      if (selected.status !== "resolved" || !sameResolvedTarget(selected.target, target))
        throw fail("stale");
      const action: AuthorizationRequest = {
        target: {
          kind: "connection" as const,
          id: target.connectionId,
          resource: target.calendarId,
        },
        operation,
      };
      const initial = await database.transaction(ownerId, (scope) =>
        scope.authorization.evaluate(action),
      );
      if (initial.decision === "ask" && !(await options.approved?.(action)))
        throw fail("approval_required");
      if (initial.decision === "deny" || !initial.snapshot) throw fail("denied");
      const access = await google.access(ownerId, target.connectionId, deadline);
      const allowed = () =>
        database.transaction(ownerId, async (scope) => {
          const policy = await scope.authorization.evaluate(action, initial.snapshot ?? undefined);
          const credential = await scope.credentials.find(target.connectionId);
          const preferences = await scope.connectionTargets.preferences();
          const currentTask = await scope.connectionTargets.currentTask({
            operation,
            ...(target.task ? { task: target.task } : {}),
          });
          return (
            policy.decision !== "deny" &&
            credential?.revision === access.revision &&
            preferences.revision === target.preferencesRevision &&
            currentTask
          );
        });
      if (!(await allowed())) throw fail("stale");
      if (initial.decision === "ask" && !(await options.approved?.(action))) throw fail("stale");
      if (options.authorize && !(await options.authorize())) throw fail("stale");
      deadline.throwIfAborted();
      const url = new URL(`${base}${path}`);
      if (!url.href.startsWith(base)) throw fail("unavailable");
      url.search = query.toString();
      const response = await (options.fetch ?? fetch)(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${access.grant.accessToken}` },
        redirect: "error",
        cache: "no-store",
        signal: deadline,
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401)
          await google.rejected(ownerId, target.connectionId, access.revision);
        throw fail("unavailable");
      }
      const data = await boundedJson(response, limit, fail);
      if (!(await allowed())) throw fail("stale");
      if (initial.decision === "ask" && !(await options.approved?.(action))) throw fail("stale");
      if (options.authorize && !(await options.authorize())) throw fail("stale");
      return { source: selected.target, data };
    } catch (error) {
      if (error instanceof GoogleReadError) throw error;
      // Never expose provider errors, credentials or response content.
      throw fail("unavailable");
    }
  };
}
