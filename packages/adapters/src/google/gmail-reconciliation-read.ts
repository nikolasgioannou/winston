import type { ServiceRequest } from "@winston/contracts/capabilities";
import { cliResultSchema, type CliResult } from "@winston/contracts/cli";
import {
  gmailReconciliationReadSchema,
  type GmailReconciliationRead,
} from "@winston/contracts/gmail-reconciliation";
import { readGmailMutationPlan } from "./gmail-mutation-plan";
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
      !["gmail.draft", "gmail.send"].includes(action.request.authorization.operation)
    )
      return { version: 1, status: "denied", message: "Uncertain Gmail operation is unavailable." };
    const plan = readGmailMutationPlan(action.request.arguments);
    if (plan.prepared.target.connectionId !== request.accountId) throw new Error("Wrong account.");
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
        ...plan.prepared.target,
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
    const evidence = await observeGmailMutation(
      {
        ...options,
        authorize,
        approved: (authorization) =>
          database.transaction(ownerId, ({ actions }) =>
            actions.authorizeConnectionRead({ ...proof, authorization }),
          ),
      },
      ownerId,
      plan,
      selected.target,
      signal,
    );
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
