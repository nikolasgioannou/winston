import type { ActionOutcome, ActionTask } from "@winston/contracts/actions";
import {
  gmailDraftIdentitySchema,
  gmailWriteMessageResponseSchema,
  gmailWriteDraftResponseSchema,
  gmailMutationReceiptSchema,
} from "@winston/contracts/gmail-mutation-responses";
import type { createArtifactReader } from "../artifacts";
import type { GoogleReadOptions } from "./read-request";
import { readGmailMutationPlan, rebuildGmailMutation } from "./gmail-mutation-plan";
import { readGmailOutgoingAttachments } from "./gmail-outgoing-attachments";
import { createConnectionTargets } from "./targets";
import { readGmailResponse } from "./gmail-response";

type Options = Pick<GoogleReadOptions, "database" | "google" | "fetch"> & {
  read: ReturnType<typeof createArtifactReader>;
};

export function createGmailMutationExecutor(options: Options) {
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
      if (
        !candidate ||
        !["gmail.draft", "gmail.send"].includes(candidate.request.authorization.operation)
      )
        return null;
      readGmailMutationPlan(candidate.request.arguments);
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
      const plan = readGmailMutationPlan(action.request.arguments);
      const target = {
        ...plan.prepared.target,
        task: { id: worker.id, revision: worker.revision },
      };
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
      const authorized = () =>
        database.transaction(ownerId, ({ actions }) => actions.authorizeGmailMutation(proof));
      if (!(await authorized()) || !(await targets.revalidate(ownerId, target, deadline)))
        throw new Error("Gmail mutation authority changed.");
      const attachments = await readGmailOutgoingAttachments(
        options.read,
        ownerId,
        plan.prepared.message.attachments,
        deadline,
      );
      const rebuilt = await rebuildGmailMutation(plan, attachments);
      const access = await google.access(ownerId, target.connectionId, deadline);
      const current = () =>
        database.transaction(ownerId, async ({ actions, credentials }) => {
          if (!(await actions.authorizeGmailMutation(proof))) return false;
          return (await credentials.find(target.connectionId))?.revision === access.revision;
        });
      if (!(await current())) throw new Error("Gmail credentials or authority changed.");
      const provider = options.fetch ?? fetch;
      const headers = { Authorization: `Bearer ${access.grant.accessToken}` };
      if (plan.draft) {
        // This fixed-field version check is intrinsic to the approved draft replacement/send.
        // It returns no message content and is not a general read capability or atomic CAS.
        const url = new URL(
          `https://gmail.googleapis.com/gmail/v1/users/me/drafts/${encodeURIComponent(plan.draft.id)}`,
        );
        url.searchParams.set("format", "minimal");
        url.searchParams.set("fields", "id,message(id)");
        deadline.throwIfAborted();
        const response = await provider(url, {
          method: "GET",
          headers,
          signal: deadline,
          redirect: "error",
          cache: "no-store",
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          if (response.status === 401)
            await google.rejected(ownerId, target.connectionId, access.revision).catch(() => {});
          throw new Error("Gmail draft version is unavailable.");
        }
        const identity = gmailDraftIdentitySchema.parse(await readGmailResponse(response));
        if (identity.id !== plan.draft.id || identity.message.id !== plan.draft.messageId)
          throw new Error("Gmail draft version changed.");
      }
      if (!(await current())) throw new Error("Gmail mutation authority changed before dispatch.");
      const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/${plan.path}`);
      const sending = plan.kind.endsWith("send");
      url.searchParams.set("fields", sending ? "id,threadId" : "id,message(id,threadId)");
      deadline.throwIfAborted();
      attempted = true;
      const response = await provider(url, {
        method: plan.method,
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(rebuilt.body),
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
            ? "Google rejected this Gmail mutation. It was not retried."
            : "Google did not confirm this Gmail mutation. Reconcile it before another write.",
        };
        if (response.status === 401)
          await google.rejected(ownerId, target.connectionId, access.revision).catch(() => {});
      } else {
        if (response.status !== 200) {
          await response.body?.cancel().catch(() => {});
          throw new Error("Unexpected Gmail response status.");
        }
        const data = await readGmailResponse(response);
        const draft = sending ? null : gmailWriteDraftResponseSchema.parse(data);
        const message = draft?.message ?? gmailWriteMessageResponseSchema.parse(data);
        if (plan.kind === "draft.update" && draft?.id !== plan.draft?.id)
          throw new Error("Gmail returned a different draft.");
        const receipt = gmailMutationReceiptSchema.parse({
          version: 1,
          kind: plan.kind,
          draftId: draft?.id ?? plan.draft?.id ?? null,
          messageId: message.id,
          threadId: message.threadId,
        });
        const matchesThread =
          !plan.prepared.message.reply || message.threadId === plan.prepared.message.reply.threadId;
        outcome = {
          state: matchesThread ? "succeeded" : "unknown",
          detail: !matchesThread
            ? "Google accepted the message in a different thread. Inspect the recorded receipt; do not resend."
            : sending
              ? "Google accepted the exact message for sending. This does not confirm recipient delivery."
              : "Google confirmed the exact draft write.",
          providerReference: JSON.stringify(receipt),
        };
      }
    } catch {
      outcome = {
        state: attempted ? "unknown" : "failed",
        providerReference: null,
        detail: attempted
          ? "The Gmail mutation has no confirmed result. Do not resend without reconciliation."
          : "The Gmail mutation was not sent because its authority, account, draft version, attachments or credentials changed or were unavailable.",
      };
    }
    const recorded = await database.transaction(ownerId, ({ actions }) =>
      actions.report(action.id, claim.token, outcome),
    );
    if (!recorded) throw new Error("Gmail mutation outcome could not be recorded.");
    return recorded;
  };
}
