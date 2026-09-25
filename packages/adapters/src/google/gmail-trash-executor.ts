import type { ActionOutcome, ActionTask } from "@winston/contracts/actions";
import { gmailLabelWriteResponseSchema } from "@winston/contracts/gmail-label-mutations";
import type { GoogleReadOptions } from "./read-request";
import { readGmailTrashPlan, gmailTrashStateMatches } from "./gmail-trash-plan";
import { createConnectionTargets } from "./targets";
import { readGmailResponse } from "./gmail-response";

type Options = Pick<GoogleReadOptions, "database" | "google" | "fetch">;
export function createGmailTrashExecutor(options: Options) {
  const { database, google } = options;
  const targets = createConnectionTargets(database, google);
  return async (
    ownerId: string,
    actionId: string,
    hash: string,
    worker: ActionTask,
    signal: AbortSignal,
  ) => {
    const claim = await database.transaction(ownerId, async ({ actions }) => {
      const candidate = await actions.find(actionId);
      if (candidate?.request.authorization.operation !== "gmail.trash") return null;
      readGmailTrashPlan(candidate.request.arguments);
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
      const plan = readGmailTrashPlan(action.request.arguments);
      const target = { ...plan.target, task: { id: worker.id, revision: worker.revision } };
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
      if (
        !(await database.transaction(ownerId, ({ actions }) =>
          actions.authorizeGmailTrash(proof),
        )) ||
        !(await targets.revalidate(ownerId, target, deadline))
      )
        throw new Error("Gmail trash authority changed.");
      const access = await google.access(ownerId, target.connectionId, deadline);
      const current = () =>
        database.transaction(
          ownerId,
          async ({ actions, credentials }) =>
            (await actions.authorizeGmailTrash(proof)) &&
            (await credentials.find(target.connectionId))?.revision === access.revision,
        );
      if (!(await current())) throw new Error("Gmail trash authority changed.");
      const provider = options.fetch ?? fetch;
      const headers = { Authorization: `Bearer ${access.grant.accessToken}` };
      const base = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(plan.message.id)}`;
      const guardUrl = new URL(base);
      guardUrl.searchParams.set("format", "minimal");
      guardUrl.searchParams.set("fields", "id,threadId,labelIds");
      deadline.throwIfAborted();
      const guard = await provider(guardUrl, {
        method: "GET",
        headers,
        signal: deadline,
        redirect: "error",
        cache: "no-store",
      });
      if (guard.status !== 200) {
        await guard.body?.cancel().catch(() => {});
        if (guard.status === 401)
          await google.rejected(ownerId, target.connectionId, access.revision).catch(() => {});
        throw new Error("Gmail message state unavailable.");
      }
      const message = gmailLabelWriteResponseSchema.parse(await readGmailResponse(guard));
      if (
        message.id !== plan.message.id ||
        message.threadId !== plan.message.threadId ||
        message.labelIds.includes("DRAFT") ||
        gmailTrashStateMatches(plan, message.labelIds)
      )
        throw new Error("Gmail message state changed.");
      if (!(await current())) throw new Error("Gmail trash authority changed before dispatch.");
      const url = new URL(`${base}/${plan.kind === "message.trash" ? "trash" : "untrash"}`);
      url.searchParams.set("fields", "id,threadId,labelIds");
      deadline.throwIfAborted();
      attempted = true;
      const response = await provider(url, {
        method: "POST",
        headers,
        signal: deadline,
        redirect: "error",
        cache: "no-store",
      });
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => {});
        const rejected = [400, 401, 403, 404, 410, 412, 429].includes(response.status);
        outcome = {
          state: rejected ? "failed" : "unknown",
          providerReference: null,
          detail: rejected
            ? "Google rejected the trash/restore operation. It was not retried."
            : "Google did not confirm the trash/restore result. Reconcile before another write.",
        };
        if (response.status === 401)
          await google.rejected(ownerId, target.connectionId, access.revision).catch(() => {});
      } else {
        const result = gmailLabelWriteResponseSchema.parse(await readGmailResponse(response));
        if (
          result.id !== plan.message.id ||
          result.threadId !== plan.message.threadId ||
          !gmailTrashStateMatches(plan, result.labelIds)
        )
          throw new Error("Gmail did not confirm the requested state.");
        outcome = {
          state: "succeeded",
          providerReference: result.id,
          detail:
            plan.kind === "message.trash"
              ? "Google confirmed the message is in Trash."
              : "Google confirmed the message is no longer in Trash. No destination folder was requested.",
        };
      }
    } catch {
      outcome = {
        state: attempted ? "unknown" : "failed",
        providerReference: null,
        detail: attempted
          ? "The trash/restore result is unconfirmed. Do not resend without reconciliation."
          : "The trash/restore request was not sent because authority or message state changed or was unavailable.",
      };
    }
    const recorded = await database.transaction(ownerId, ({ actions }) =>
      actions.report(action.id, claim.token, outcome),
    );
    if (!recorded) throw new Error("Gmail trash outcome could not be recorded.");
    return recorded;
  };
}
