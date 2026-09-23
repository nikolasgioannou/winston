import { sql } from "drizzle-orm";
import {
  registeredWorkspaceSchema,
  workspaceOperationSchema,
  workspaceStateSchema,
  workspaceWorkerSchema,
  type RegisteredWorkspace,
  type WorkspaceOperation,
  type WorkspaceWorker,
} from "@winston/contracts/workspace";
import { serviceRequestSchema, type ServiceRequest } from "@winston/contracts/capabilities";
import type { DatabaseTransaction } from "./owners";
import { capabilityRepository } from "./capabilities";
import { eventRepository } from "./events";

export function workspaceRepository(transaction: DatabaseTransaction, ownerId: string) {
  async function find(inputId: string, lock = false) {
    const id = registeredWorkspaceSchema.shape.id.parse(inputId);
    const result = await transaction.execute<RegisteredWorkspace>(sql`
      SELECT id, name, state, revision FROM winston.workspaces
      WHERE owner_id = ${ownerId}::uuid AND id = ${id}::uuid
      ${lock ? sql`FOR SHARE` : sql``}
    `);
    return result.rows[0] ? registeredWorkspaceSchema.parse(result.rows[0]) : null;
  }

  return {
    find,
    // Trusted provisioning only. Registration creates no execution authority.
    async register(inputId: string, inputName: string) {
      const id = registeredWorkspaceSchema.shape.id.parse(inputId);
      const name = registeredWorkspaceSchema.shape.name.parse(inputName);
      await transaction.execute(sql`
        INSERT INTO winston.workspaces (owner_id, id, name) VALUES (${ownerId}::uuid, ${id}::uuid, ${name})
        ON CONFLICT (owner_id, id) DO NOTHING
      `);
      const workspace = await find(id);
      if (!workspace || workspace.name !== name)
        throw new Error("Workspace registration conflicts with existing identity.");
      return workspace;
    },
    async setState(
      inputId: string,
      inputRevision: number,
      inputState: RegisteredWorkspace["state"],
    ) {
      const id = registeredWorkspaceSchema.shape.id.parse(inputId);
      const revision = registeredWorkspaceSchema.shape.revision.parse(inputRevision);
      const state = workspaceStateSchema.parse(inputState);
      const result = await transaction.execute<RegisteredWorkspace>(sql`
        UPDATE winston.workspaces SET state = ${state}, revision = revision + 1
        WHERE owner_id = ${ownerId}::uuid AND id = ${id}::uuid AND revision = ${revision}
          AND state <> 'retired' AND state <> ${state}
        RETURNING id, name, state, revision
      `);
      const row = result.rows[0];
      if (!row) return null;
      const workspace = registeredWorkspaceSchema.parse(row);
      await eventRepository(transaction, ownerId).publish({
        key: `${workspace.id}:${String(workspace.revision)}`,
        type: "workspace.changed",
        payload: {
          workspaceId: workspace.id,
          state: workspace.state,
          revision: workspace.revision,
        },
        destinations: ["task-runtime"],
      });
      return workspace;
    },
    // Worker orchestration calls this only after selecting the owner's workspace for the task.
    async issueExecution(input: WorkspaceWorker) {
      const worker = workspaceWorkerSchema.parse(input);
      const workspace = await find(worker.workspaceId, true);
      if (workspace?.state !== "active") throw new Error("Workspace is unavailable.");
      return capabilityRepository(transaction, ownerId).issue({
        kind: "worker",
        subjectId: worker.workerId,
        taskId: worker.taskId,
        revision: worker.revision,
        generation: worker.generation,
        operation: "workspace:execute",
        resourceId: workspace.id,
        resourceRevision: workspace.revision,
        credential: null,
      });
    },
    async authorize(input: ServiceRequest, inputOperation: WorkspaceOperation) {
      const request = serviceRequestSchema.parse(input);
      const operation = workspaceOperationSchema.parse(inputOperation);
      if (
        request.kind !== "worker" ||
        request.operation !== "workspace:execute" ||
        operation.identity.ownerId !== ownerId ||
        operation.identity.workspaceId !== request.resourceId
      )
        return null;
      const workspace = await find(request.resourceId, true);
      if (workspace?.state !== "active") return null;
      const authority = await capabilityRepository(transaction, ownerId).authenticate(request);
      if (
        !authority ||
        authority.resourceRevision !== workspace.revision ||
        authority.taskId !== operation.taskId ||
        authority.revision !== operation.revision ||
        authority.generation !== operation.generation
      )
        return null;
      return {
        version: 1 as const,
        allowed: true as const,
        operation,
        workspaceRevision: workspace.revision,
      };
    },
  };
}

export type WorkspaceRepository = ReturnType<typeof workspaceRepository>;
