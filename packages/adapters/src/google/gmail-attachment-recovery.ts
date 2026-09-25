import type { ServiceRequest } from "@winston/contracts/capabilities";
import type { CliResult } from "@winston/contracts/cli";
import type { createDatabase } from "../database";
import type { AttachmentStore, GmailAttachmentRead } from "./gmail-attachment-artifacts";
import { readGmailAttachmentArtifact } from "./gmail-attachment-result";

export async function recoverGmailAttachment(options: {
  database: ReturnType<typeof createDatabase>;
  artifacts: AttachmentStore;
  ownerId: string;
  credential: ServiceRequest;
  request: GmailAttachmentRead;
  actionId: string;
  signal: AbortSignal;
}): Promise<CliResult> {
  const { database, artifacts, ownerId, credential, request, actionId, signal } = options;
  const unknown = (): CliResult => ({
    version: 1,
    status: "unknown",
    referenceId: actionId,
    message: "Attachment storage has not been confirmed. No Gmail read or upload was repeated.",
  });
  signal.throwIfAborted();
  const inspected = await database.transaction(ownerId, async (scope) => {
    const authority = await scope.capabilities.authenticate(credential);
    if (authority?.operation !== "gateway:control") return { kind: "denied" as const };
    const action = await scope.actions.recover(actionId);
    if (action?.state === "dispatching") return { kind: "pending" as const };
    const allowed = await scope.actions.authorizeGmailAttachmentReceipt({
      id: actionId,
      task: {
        id: authority.taskId,
        revision: authority.revision,
        generation: authority.generation,
      },
      request,
    });
    if (!allowed) return { kind: "denied" as const };
    return {
      kind: "artifact" as const,
      artifact: await scope.artifacts.findByKey(`gmail-attachment:${actionId}`),
    };
  });
  if (inspected.kind === "denied")
    return {
      version: 1,
      status: "denied",
      message: "Attachment read authority is unavailable or changed.",
    };
  if (inspected.kind === "pending" || !inspected.artifact) return unknown();
  try {
    let artifact = readGmailAttachmentArtifact(inspected.artifact, request, actionId);
    if (["uploading", "verifying"].includes(artifact.state)) {
      signal.throwIfAborted();
      const verified = await artifacts.reconcile(ownerId, artifact.id);
      if (!verified) return unknown();
      artifact = readGmailAttachmentArtifact(verified, request, actionId);
    }
    signal.throwIfAborted();
    if (artifact.state !== "ready") return unknown();
    const result = await database.transaction(ownerId, ({ connectedReads }) =>
      connectedReads.reconcileAttachment(credential, actionId, artifact.id, request),
    );
    return (
      result ?? { version: 1, status: "denied", message: "Attachment receipt authority changed." }
    );
  } catch {
    return unknown();
  }
}
