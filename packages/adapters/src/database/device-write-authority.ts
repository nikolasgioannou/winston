import type { ActionRecord, ActionTask } from "@winston/contracts/actions";
import { deviceOperationSchema } from "@winston/contracts/devices";
import type { DatabaseTransaction } from "./owners";
import { deviceWriteSource } from "./device-write-source";
import { findDeviceWrite } from "./device-write-record";

// Destination execution checks happen in actions; this independently requires the original source.
export async function deviceWriteAuthority(
  transaction: DatabaseTransaction,
  ownerId: string,
  action: ActionRecord,
  worker: ActionTask,
) {
  const parsed = deviceOperationSchema.safeParse(action.request.arguments);
  if (!parsed.success || parsed.data.kind !== "file.write") return null;
  const operation = parsed.data;
  const bound = await findDeviceWrite(transaction, ownerId, action.id);
  if (
    !bound ||
    bound.transferId !== operation.transferId ||
    bound.artifactId !== operation.source.artifactId ||
    bound.artifactRevision !== operation.source.revision ||
    (bound.sourceActionId === null) === (bound.stagingTransferId === null)
  )
    return null;
  const proof = bound.sourceActionId
    ? { kind: "publication" as const, actionId: bound.sourceActionId }
    : bound.stagingTransferId
      ? { kind: "staged" as const, transferId: bound.stagingTransferId }
      : null;
  if (!proof) return null;
  return deviceWriteSource(transaction, ownerId, {
    worker,
    intentRevision: action.intentRevision,
    workspaceId: bound.workspaceId,
    workspaceRevision: bound.workspaceRevision,
    source: operation.source,
    proof,
  });
}
