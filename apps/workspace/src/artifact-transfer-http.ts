import {
  artifactTransferSchema,
  artifactTransferTokenSchema,
  type ArtifactTransfer,
} from "@winston/contracts/artifacts";
import type { WorkspaceIdentity } from "@winston/contracts/workspace";
import type { openWorkspaceInbox } from "./inbox";
import { createBinaryTransferHandler, type TransferSlots } from "./binary-transfer-http";

export function createArtifactTransferHandler(options: {
  identity: WorkspaceIdentity;
  inbox: ReturnType<typeof openWorkspaceInbox>;
  authorize: (token: string, transfer: ArtifactTransfer) => Promise<boolean>;
  slots: TransferSlots;
}) {
  return createBinaryTransferHandler({
    ...options,
    path: "/v1/artifacts",
    tokenSchema: artifactTransferTokenSchema,
    transferSchema: artifactTransferSchema,
  });
}
