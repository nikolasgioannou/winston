import type { ActionOutcome, ActionTask } from "@winston/contracts/actions";
import { calendarProviderEventSchema } from "@winston/contracts/calendar";
import type { GoogleReadOptions } from "./read-request";
import { readCalendarMutationArguments } from "./calendar-mutation-plan";
import { createConnectionTargets } from "./targets";

async function responseEvent(response: Response) {
  if (!response.body) throw new Error("Missing Calendar response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk: unknown = next.value;
      if (!(chunk instanceof Uint8Array)) throw new Error("Invalid Calendar response.");
      size += chunk.length;
      if (size > 1_000_000) throw new Error("Calendar response too large.");
      chunks.push(chunk);
    }
    return calendarProviderEventSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

type Options = Pick<GoogleReadOptions, "database" | "google" | "fetch">;

// Internal adapter: callers already own the task. No dispatch token is accepted from a client.
export function createCalendarMutationExecutor(options: Options) {
  const { database, google } = options;
  const targets = createConnectionTargets(database, google);
  return async (
    ownerId: string,
    actionId: string,
    hash: string,
    worker: ActionTask,
    signal: AbortSignal,
  ) => {
    // This transaction commits before contacting Google. Repeated calls cannot claim again.
    const claim = await database.transaction(ownerId, async ({ actions }) => {
      const candidate = await actions.find(actionId);
      if (candidate?.request.authorization.operation !== "calendar.write") return null;
      readCalendarMutationArguments(candidate.request.arguments);
      return actions.claim(actionId, hash, worker);
    });
    if (!claim?.claimed) return claim?.action ?? null;
    const action = claim.action;
    const proof = {
      id: action.id,
      token: claim.token,
      task: worker,
      authorization: action.request.authorization,
      arguments: action.request.arguments,
    };
    let attempted = false;
    let outcome: ActionOutcome;
    try {
      const { plan } = readCalendarMutationArguments(action.request.arguments);
      const target = { ...plan.request.target, task: { id: worker.id, revision: worker.revision } };
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
      if (
        !(await database.transaction(ownerId, ({ actions }) =>
          actions.authorizeCalendarMutation(proof),
        ))
      )
        throw new Error("Calendar mutation authority changed.");
      if (!(await targets.revalidate(ownerId, target, deadline)))
        throw new Error("Calendar target changed.");
      const access = await google.access(ownerId, target.connectionId, deadline);
      const allowed = await database.transaction(ownerId, async ({ actions, credentials }) => {
        if (!(await actions.authorizeCalendarMutation(proof))) return false;
        const credential = await credentials.find(target.connectionId);
        return credential?.revision === access.revision;
      });
      if (!allowed) throw new Error("Calendar credentials or authority changed.");
      const url = new URL(`https://www.googleapis.com/calendar/v3/${plan.path}`);
      url.searchParams.set("sendUpdates", plan.sendUpdates);
      deadline.throwIfAborted();
      attempted = true;
      const response = await (options.fetch ?? fetch)(url, {
        method: plan.method,
        headers: {
          Authorization: `Bearer ${access.grant.accessToken}`,
          ...(plan.ifMatch ? { "If-Match": plan.ifMatch } : {}),
          ...(plan.body ? { "Content-Type": "application/json" } : {}),
        },
        ...(plan.body ? { body: JSON.stringify(plan.body) } : {}),
        signal: deadline,
        redirect: "error",
        cache: "no-store",
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        // A collision is not proof that our operation created the existing event.
        // Server errors and transport loss may occur after a write has taken effect.
        const rejected = [400, 401, 403, 404, 410, 412, 429].includes(response.status);
        outcome = {
          state: rejected ? "failed" : "unknown",
          detail:
            response.status === 412
              ? "The event changed before this write. Read it again and prepare a new approval."
              : rejected
                ? "Google rejected this Calendar mutation. It was not retried."
                : "Google did not confirm this Calendar mutation. It must be reconciled before another write.",
          providerReference: null,
        };
        if (response.status === 401)
          await google.rejected(ownerId, target.connectionId, access.revision).catch(() => {});
      } else {
        if (plan.method === "DELETE") {
          await response.body?.cancel().catch(() => {});
          if (response.status !== 204) throw new Error("Unexpected Calendar deletion response.");
        } else {
          const event = await responseEvent(response);
          if (event.id !== plan.eventId || !event.etag || event.status === "cancelled")
            throw new Error("Calendar result did not confirm the planned event.");
        }
        outcome = {
          state: "succeeded",
          detail: "Google confirmed the Calendar mutation.",
          providerReference: plan.eventId,
        };
      }
    } catch {
      outcome = {
        state: attempted ? "unknown" : "failed",
        detail: attempted
          ? "The Calendar mutation has no confirmed result. Do not resend it without reconciliation."
          : "The Calendar mutation was not sent because its authority, target, credentials or connection was unavailable.",
        providerReference: null,
      };
    }
    // Provider facts remain recordable after a task cancellation. A receipt cannot authorize a resend.
    const recorded = await database.transaction(ownerId, ({ actions }) =>
      actions.report(action.id, claim.token, outcome),
    );
    if (!recorded) throw new Error("Calendar mutation outcome could not be recorded.");
    return recorded;
  };
}
