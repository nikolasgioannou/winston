import { sql } from "drizzle-orm";
import {
  deviceFileWriteRequestSchema,
  type DeviceFileWriteRequest,
} from "@winston/contracts/device-file-writes";
import { deviceFileSourceSchema, deviceOperationSchema } from "@winston/contracts/devices";
import type { DeviceFileAuthority } from "@winston/contracts/device-executions";
import type { ServiceRequest } from "@winston/contracts/capabilities";
import type { DatabaseTransaction } from "./owners";
import { capabilityRepository } from "./capabilities";
import { actionRepository } from "./actions";
import { artifactRepository } from "./artifacts";
import { deviceActionRepository, DeviceActionPreparationError } from "./device-actions";
import { deviceWriteSource } from "./device-write-source";
import { findDeviceWrite } from "./device-write-record";
import { deviceWriteAuthority } from "./device-write-authority";

export function deviceFileWriteRepository(transaction: DatabaseTransaction, ownerId: string) {
  return {
    async prepare(credential: ServiceRequest, input: DeviceFileWriteRequest) {
      const request = deviceFileWriteRequestSchema.parse(input);
      await transaction.execute(
        sql`SELECT id FROM winston.owners WHERE id = ${ownerId}::uuid FOR UPDATE`,
      );
      const authority = await capabilityRepository(transaction, ownerId).authenticate(credential);
      if (authority?.operation !== "gateway:control" || authority.resourceRevision === undefined)
        return null;
      const artifact = await artifactRepository(transaction, ownerId).find(
        request.artifactId,
        true,
      );
      if (artifact?.state !== "ready" || artifact.revision !== request.revision) return null;
      const descriptor = deviceFileSourceSchema.safeParse({
        artifactId: artifact.id,
        revision: artifact.revision,
        size: artifact.metadata.size,
        sha256: artifact.metadata.sha256,
      });
      if (!descriptor.success) return null;
      const rows = await transaction.execute<{ intentRevision: number }>(sql`
        SELECT intent_revision AS "intentRevision" FROM winston.tasks
        WHERE owner_id = ${ownerId}::uuid AND id = ${authority.taskId}::uuid
      `);
      const current = rows.rows[0];
      if (!current) return null;
      const worker = {
        id: authority.taskId,
        revision: authority.revision,
        generation: authority.generation,
      };
      const source = await deviceWriteSource(transaction, ownerId, {
        worker,
        intentRevision: current.intentRevision,
        workspaceId: authority.resourceId,
        workspaceRevision: authority.resourceRevision,
        source: descriptor.data,
      });
      if (!source) return null;
      const action = await deviceActionRepository(transaction, ownerId).prepareFileWrite(
        worker,
        request.key,
        request.id,
        request.path,
        request.overwrite,
        descriptor.data,
      );
      const operation = deviceOperationSchema.parse(action.request.arguments);
      if (operation.kind !== "file.write") throw new DeviceActionPreparationError("conflict");
      const existing = await findDeviceWrite(transaction, ownerId, action.id);
      if (existing) {
        if (
          existing.workspaceId !== authority.resourceId ||
          existing.workspaceRevision !== authority.resourceRevision
        )
          throw new DeviceActionPreparationError("conflict");
        if (!(await deviceWriteAuthority(transaction, ownerId, action, worker)))
          throw new DeviceActionPreparationError("unavailable");
      } else {
        await transaction.execute(sql`
          INSERT INTO winston.device_file_writes (
            owner_id, action_id, transfer_id, workspace_id, workspace_revision,
            artifact_id, artifact_revision, source_action_id, staging_transfer_id
          ) VALUES (
            ${ownerId}::uuid, ${action.id}::uuid, ${operation.transferId}::uuid,
            ${authority.resourceId}::uuid, ${authority.resourceRevision},
            ${artifact.id}::uuid, ${artifact.revision},
            ${source.proof.kind === "publication" ? source.proof.actionId : null}::uuid,
            ${source.proof.kind === "staged" ? source.proof.transferId : null}::uuid
          )
        `);
      }
      return { action, task: worker };
    },
    async authorize(authenticatedDeviceId: string, proof: DeviceFileAuthority) {
      if (proof.operation !== "file.write") return null;
      const actions = actionRepository(transaction, ownerId);
      const execution = await actions.authorizeDeviceFileTransfer(authenticatedDeviceId, proof);
      if (!execution) return null;
      const action = await actions.find(execution.actionId);
      if (!action) return null;
      const source = await deviceWriteAuthority(transaction, ownerId, action, execution.task);
      return source ? { execution, artifact: source.artifact } : null;
    },
  };
}
