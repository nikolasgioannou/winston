import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  artifactTransferSchema,
  artifactTransferTokenSchema,
  artifactStageReceiptSchema,
  type ArtifactStageRequest,
  type ArtifactStageReceipt,
  type ArtifactTransfer,
} from "@winston/contracts/artifacts";
import type { ServiceRequest } from "@winston/contracts/capabilities";
import { canonicalJson } from "@winston/contracts/json";
import type { DatabaseTransaction } from "./owners";
import { capabilityHash } from "./capabilities";
import { actionRepository } from "./actions";
import { taskRepository } from "./tasks";
import { workspaceRuntimeRepository } from "./workspace-runtimes";
import { prepareArtifactStaging } from "./artifact-stage-preparation";
import { currentArtifactTransfer } from "./artifact-transfer-current";
import { findArtifactTransfer } from "./artifact-transfer-record";

type Beginning =
  | { status: "denied" }
  | { status: "unavailable" }
  | { status: "waiting"; actionId: string }
  | { status: "unknown"; actionId: string }
  | { status: "staged"; transfer: ArtifactTransfer; receipt: ArtifactStageReceipt }
  | {
      status: "transfer";
      actionId: string;
      token: string;
      transfer: ArtifactTransfer;
      origin: string;
    };

export function artifactTransferRepository(transaction: DatabaseTransaction, ownerId: string) {
  async function lock() {
    await transaction.execute(
      sql`SELECT id FROM winston.owners WHERE id = ${ownerId}::uuid FOR UPDATE`,
    );
  }
  async function authenticate(token: string) {
    if (!artifactTransferTokenSchema.safeParse(token).success) return null;
    await lock();
    const matched = await transaction.execute<{ id: string }>(sql`
      SELECT id FROM winston.artifact_transfers
      WHERE owner_id = ${ownerId}::uuid AND token_hash = ${capabilityHash(token)}
        AND state = 'active' AND expires_at > clock_timestamp()
    `);
    const row = matched.rows[0]
      ? await findArtifactTransfer(transaction, ownerId, matched.rows[0].id)
      : null;
    if (!row?.capabilityId || !row.live) return null;
    const descriptor = artifactTransferSchema.safeParse(row.descriptor);
    if (!descriptor.success || descriptor.data.transferId !== row.id) return null;
    const current = await currentArtifactTransfer(transaction, ownerId, {
      actionId: row.actionId,
      capabilityId: row.capabilityId,
      transfer: descriptor.data,
    });
    return current ? { row, transfer: descriptor.data, plan: current.plan } : null;
  }

  return {
    async authenticate(token: string) {
      return (await authenticate(token))?.transfer ?? null;
    },
    async begin(credential: ServiceRequest, input: ArtifactStageRequest): Promise<Beginning> {
      const prepared = await prepareArtifactStaging(transaction, ownerId, credential, input);
      if (!prepared) return { status: "denied" };
      const { row, action, task, plan, capabilityId } = prepared;
      const runtime = await workspaceRuntimeRepository(transaction, ownerId).resolve(
        plan.workspaceId,
      );
      if (!runtime || runtime.revision !== plan.workspaceRevision) return { status: "unavailable" };
      const actions = actionRepository(transaction, ownerId);
      if (["denied", "invalidated", "failed"].includes(action.state)) return { status: "denied" };
      if (action.state === "pending") {
        if ((await actions.expirePending(action.id))?.state !== "pending")
          return { status: "denied" };
        await taskRepository(transaction, ownerId).finishStep(
          task.id,
          task.revision,
          task.generation,
          {
            state: "waiting",
            blocker: {
              kind: "approval",
              referenceId: action.id,
              detail: "Waiting for permission to stage the selected artifact on the workspace.",
            },
          },
        );
        return { status: "waiting", actionId: action.id };
      }
      const transfer = artifactTransferSchema.parse({
        ownerId,
        workspaceId: plan.workspaceId,
        workspaceRevision: plan.workspaceRevision,
        transferId: row.id,
        artifactId: plan.request.id,
        artifactRevision: plan.request.revision,
        task,
        size: plan.size,
        sha256: plan.sha256,
      });
      if (row.state === "pending") {
        const claim = await actions.claim(action.id, action.hash, task);
        if (!claim?.claimed) return { status: "unknown", actionId: action.id };
      }
      if (
        !(await currentArtifactTransfer(transaction, ownerId, {
          actionId: action.id,
          capabilityId,
          transfer,
        }))
      )
        return { status: "denied" };
      if (row.state === "staged") {
        const receipt = artifactStageReceiptSchema.parse(row.receipt);
        if (
          receipt.path !== `/data/inbox/${transfer.artifactId}` ||
          receipt.size !== transfer.size ||
          receipt.sha256 !== transfer.sha256
        )
          throw new Error("Stored staging receipt is inconsistent.");
        return { status: "staged", transfer, receipt };
      }
      if (row.state === "active" && row.live && row.capabilityId) {
        const previous = artifactTransferSchema.safeParse(row.descriptor);
        if (
          previous.success &&
          (await currentArtifactTransfer(transaction, ownerId, {
            actionId: action.id,
            capabilityId: row.capabilityId,
            transfer: previous.data,
          }))
        )
          return { status: "unknown", actionId: action.id };
      }
      const token = `wat_${randomBytes(32).toString("base64url")}`;
      await transaction.execute(sql`
        UPDATE winston.artifact_transfers SET state = 'active', token_hash = ${capabilityHash(token)},
          source_capability_id = ${capabilityId}::uuid, expires_at = clock_timestamp() + interval '180 seconds',
          descriptor = ${JSON.stringify(transfer)}::jsonb
        WHERE owner_id = ${ownerId}::uuid AND id = ${row.id}::uuid
      `);
      return { status: "transfer", actionId: action.id, token, transfer, origin: runtime.origin };
    },
    async retry(token: string) {
      if (!artifactTransferTokenSchema.safeParse(token).success) return;
      await lock();
      await transaction.execute(sql`
        UPDATE winston.artifact_transfers SET state = 'unknown', expires_at = clock_timestamp()
        WHERE owner_id = ${ownerId}::uuid AND token_hash = ${capabilityHash(token)} AND state = 'active'
      `);
    },
    async complete(token: string, expected: ArtifactTransfer, input: ArtifactStageReceipt) {
      const transfer = artifactTransferSchema.parse(expected);
      const receipt = artifactStageReceiptSchema.parse(input);
      const current = await authenticate(token);
      if (!current || canonicalJson(current.transfer) !== canonicalJson(transfer)) return null;
      if (
        receipt.path !== `/data/inbox/${transfer.artifactId}` ||
        receipt.size !== transfer.size ||
        receipt.sha256 !== transfer.sha256
      )
        return null;
      const confirmed = await actionRepository(transaction, ownerId).confirmArtifactStaging(
        {
          id: current.row.actionId,
          transferId: transfer.transferId,
          task: transfer.task,
          plan: current.plan,
        },
        receipt,
      );
      if (!confirmed) return null;
      await transaction.execute(sql`
        UPDATE winston.artifact_transfers SET state = 'staged', receipt = ${JSON.stringify(receipt)}::jsonb,
          token_hash = NULL, expires_at = clock_timestamp()
        WHERE owner_id = ${ownerId}::uuid AND id = ${transfer.transferId}::uuid
      `);
      return receipt;
    },
  };
}
