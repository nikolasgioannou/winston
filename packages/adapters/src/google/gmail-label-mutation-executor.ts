import type { ActionOutcome, ActionTask } from "@winston/contracts/actions";
import { gmailLabelSchema } from "@winston/contracts/gmail";
import { gmailLabelWriteResponseSchema } from "@winston/contracts/gmail-label-mutations";
import type { GoogleReadOptions } from "./read-request";
import { readGmailLabelMutationPlan, gmailLabelsMatch } from "./gmail-label-mutation-plan";
import { createConnectionTargets } from "./targets";
import { readGmailResponse } from "./gmail-response";

type Options = Pick<GoogleReadOptions, "database" | "google" | "fetch">;
export function createGmailLabelMutationExecutor(options: Options) {
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
      if (candidate?.request.authorization.operation !== "gmail.modify") return null;
      readGmailLabelMutationPlan(candidate.request.arguments);
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
      const plan = readGmailLabelMutationPlan(action.request.arguments);
      const target = { ...plan.target, task: { id: worker.id, revision: worker.revision } };
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
      const authorized = () =>
        database.transaction(ownerId, ({ actions }) => actions.authorizeGmailLabelMutation(proof));
      if (!(await authorized()) || !(await targets.revalidate(ownerId, target, deadline)))
        throw new Error("Gmail label authority changed.");
      const access = await google.access(ownerId, target.connectionId, deadline);
      const current = () =>
        database.transaction(
          ownerId,
          async ({ actions, credentials }) =>
            (await actions.authorizeGmailLabelMutation(proof)) &&
            (await credentials.find(target.connectionId))?.revision === access.revision,
        );
      const provider = options.fetch ?? fetch;
      const headers = { Authorization: `Bearer ${access.grant.accessToken}` };
      const guard = async (path: string, fields: string, minimal = false) => {
        if (!(await current())) throw new Error("Gmail label authority changed.");
        const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`);
        url.searchParams.set("fields", fields);
        if (minimal) url.searchParams.set("format", "minimal");
        deadline.throwIfAborted();
        const response = await provider(url, {
          method: "GET",
          headers,
          signal: deadline,
          redirect: "error",
          cache: "no-store",
        });
        if (response.status !== 200) {
          await response.body?.cancel().catch(() => {});
          if (response.status === 401)
            await google.rejected(ownerId, target.connectionId, access.revision).catch(() => {});
          throw new Error("Gmail label guard unavailable.");
        }
        return readGmailResponse(response);
      };
      // Exact-ID metadata guards are intrinsic to this modification, not general mail reads.
      const message = gmailLabelWriteResponseSchema.parse(
        await guard(
          `messages/${encodeURIComponent(plan.message.id)}`,
          "id,threadId,labelIds",
          true,
        ),
      );
      if (
        message.id !== plan.message.id ||
        message.threadId !== plan.message.threadId ||
        message.labelIds.some((id) => id === "DRAFT" || id === "TRASH")
      )
        throw new Error("Message changed or needs a different permission.");
      for (const expected of [...plan.add, ...plan.remove]) {
        const label = gmailLabelSchema.parse(
          await guard(`labels/${encodeURIComponent(expected.id)}`, "id,name,type"),
        );
        if (
          label.id !== expected.id ||
          label.name !== expected.name ||
          label.type !== expected.type
        )
          throw new Error("Label identity or name changed.");
      }
      if (!(await current())) throw new Error("Gmail label authority changed before dispatch.");
      const url = new URL(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(plan.message.id)}/modify`,
      );
      url.searchParams.set("fields", "id,threadId,labelIds");
      deadline.throwIfAborted();
      attempted = true;
      const response = await provider(url, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          addLabelIds: plan.add.map((label) => label.id),
          removeLabelIds: plan.remove.map((label) => label.id),
        }),
        signal: deadline,
        redirect: "error",
        cache: "no-store",
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        const rejected = [400, 401, 403, 404, 410, 412, 429].includes(response.status);
        outcome = {
          state: rejected ? "failed" : "unknown",
          providerReference: null,
          detail: rejected
            ? "Google rejected the label change. It was not retried."
            : "Google did not confirm the label change. Reconcile before another write.",
        };
        if (response.status === 401)
          await google.rejected(ownerId, target.connectionId, access.revision).catch(() => {});
      } else {
        if (response.status !== 200) {
          await response.body?.cancel().catch(() => {});
          throw new Error("Unexpected response status.");
        }
        const result = gmailLabelWriteResponseSchema.parse(await readGmailResponse(response));
        if (
          result.id !== plan.message.id ||
          result.threadId !== plan.message.threadId ||
          !gmailLabelsMatch(plan, result.labelIds)
        )
          throw new Error("Gmail did not confirm the exact label changes.");
        outcome = {
          state: "succeeded",
          providerReference: result.id,
          detail: "Google confirmed the requested message label changes.",
        };
      }
    } catch {
      outcome = {
        state: attempted ? "unknown" : "failed",
        providerReference: null,
        detail: attempted
          ? "The label change has no confirmed result. Do not resend without reconciliation."
          : "The label change was not sent because authority or message/label metadata changed or was unavailable.",
      };
    }
    const recorded = await database.transaction(ownerId, ({ actions }) =>
      actions.report(action.id, claim.token, outcome),
    );
    if (!recorded) throw new Error("Gmail label outcome could not be recorded.");
    return recorded;
  };
}
