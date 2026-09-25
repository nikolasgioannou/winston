import type { ServiceRequest } from "@winston/contracts/capabilities";
import { cliResultSchema, type CliResult } from "@winston/contracts/cli";
import {
  gmailReconciliationReadSchema,
  type GmailReconciliationRead,
} from "@winston/contracts/gmail-reconciliation";
import { readGmailMutationPlan } from "./gmail-mutation-plan";
import { readGmailLabelMutationPlan } from "./gmail-label-mutation-plan";
import { observeGmailLabelMutation } from "./gmail-label-reconciliation-observe";
import { readGmailTrashPlan } from "./gmail-trash-plan";
import { observeGmailTrash } from "./gmail-trash-reconciliation-observe";
import { createConnectionTargets } from "./targets";
import { sameResolvedTarget } from "./target-resolution";
import { prepareReadApproval, completeRead, type ReadDispatch } from "./read-approval";
import { observeGmailMutation } from "./gmail-reconciliation-observe";
import type { GoogleReadOptions } from "./read-request";
import type { createArtifactReader } from "../artifacts";

export type GmailReconciliationOptions = Pick<
  GoogleReadOptions,
  "database" | "google" | "fetch"
> & {
  artifacts: ReturnType<typeof createArtifactReader>;
};
export async function readGmailMutationEvidence(
  options: GmailReconciliationOptions,
  credential: ServiceRequest,
  input: GmailReconciliationRead,
  signal: AbortSignal,
): Promise<CliResult> {
  const request = gmailReconciliationReadSchema.parse(input);
  const { database } = options;
  const authority = await database.authenticateService(credential);
  if (authority?.operation !== "gateway:control")
    return { version: 1, status: "denied", message: "Task control authority is unavailable." };
  const ownerId = authority.ownerId;
  let dispatch: ReadDispatch | undefined;
  try {
    const action = await database.transaction(ownerId, ({ actions }) => actions.find(request.id));
    if (
      !action ||
      action.state !== "unknown" ||
      !["gmail.draft", "gmail.send", "gmail.modify", "gmail.trash"].includes(
        action.request.authorization.operation,
      )
    )
      return { version: 1, status: "denied", message: "Uncertain Gmail operation is unavailable." };
    const plan =
      action.request.authorization.operation === "gmail.modify"
        ? readGmailLabelMutationPlan(action.request.arguments)
        : action.request.authorization.operation === "gmail.trash"
          ? readGmailTrashPlan(action.request.arguments)
          : readGmailMutationPlan(action.request.arguments);
    const plannedTarget = "prepared" in plan ? plan.prepared.target : plan.target;
    if (plannedTarget.connectionId !== request.accountId) throw new Error("Wrong account.");
    const selected = await createConnectionTargets(database, options.google).resolve(
      ownerId,
      {
        operation: "gmail.read",
        explicit: { connectionId: request.accountId, calendarId: null },
        task: { id: authority.taskId, revision: authority.revision },
      },
      signal,
    );
    if (
      selected.status !== "resolved" ||
      !sameResolvedTarget(selected.target, {
        ...plannedTarget,
        operation: "gmail.read",
        task: selected.target.task,
      })
    )
      throw new Error("Account identity changed.");
    const approval = await prepareReadApproval(database, ownerId, credential, request);
    if (approval.kind === "result") return approval.result;
    dispatch = approval;
    const proof = approval;
    const authorize = async () => {
      const current = await database.authenticateService(credential);
      return (
        current?.ownerId === ownerId &&
        current.taskId === authority.taskId &&
        current.revision === authority.revision &&
        current.generation === authority.generation
      );
    };
    const bound = {
      ...options,
      authorize,
      approved: (authorization: Parameters<NonNullable<GoogleReadOptions["approved"]>>[0]) =>
        database.transaction(ownerId, ({ actions }) =>
          actions.authorizeConnectionRead({ ...proof, authorization }),
        ),
    };
    const evidence =
      plan.kind === "labels.modify"
        ? await observeGmailLabelMutation(bound, ownerId, plan, selected.target, signal)
        : "prepared" in plan
          ? await observeGmailMutation(bound, ownerId, plan, selected.target, signal)
          : await observeGmailTrash(bound, ownerId, plan, selected.target, signal);
    if (!(await authorize())) throw new Error("Task authority expired.");
    signal.throwIfAborted();
    return await completeRead(
      database,
      ownerId,
      dispatch,
      cliResultSchema.parse({
        version: 1,
        status: "ok",
        data: { ...evidence, readActionId: dispatch.id },
      }),
    );
  } catch {
    return completeRead(database, ownerId, dispatch, {
      version: 1,
      status: "unknown",
      message: "The evidence read did not establish the Gmail result. No write was resent.",
    });
  }
}
