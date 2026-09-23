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
import {
  serviceRequestSchema,
  workspaceControlOperationSchema,
  type ServiceRequest,
} from "@winston/contracts/capabilities";
import {
  workspaceCommandSchema,
  type WorkspaceCommand,
} from "@winston/contracts/workspace-commands";
import type { DatabaseTransaction } from "./owners";
import { capabilityRepository } from "./capabilities";
import { eventRepository } from "./events";
import { actionRepository } from "./actions";
import { findWorkspace } from "./workspace-record";
import { cliAuthoritySchema, type CliAuthority } from "@winston/contracts/cli";

export function workspaceRepository(transaction: DatabaseTransaction, ownerId: string) {
  async function lock() {
    const owner = await transaction.execute(
      sql`SELECT id FROM winston.owners WHERE id = ${ownerId}::uuid FOR UPDATE`,
    );
    if (!owner.rowCount) throw new Error("Owner unavailable.");
  }
  function find(inputId: string, lock = false) {
    return findWorkspace(transaction, ownerId, inputId, lock);
  }

  async function authorizeWorker(input: ServiceRequest, operation: WorkspaceOperation) {
    const request = serviceRequestSchema.parse(input);
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
  }

  return {
    find,
    // Trusted provisioning only. Registration creates no execution authority.
    async register(inputId: string, inputName: string) {
      await lock();
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
      await lock();
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
      await lock();
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
    async issueControl(
      subjectId: string,
      inputOperation: WorkspaceOperation,
      inputMode: "workspace:observe" | "workspace:cancel",
    ) {
      await lock();
      const operation = workspaceOperationSchema.parse(inputOperation);
      const mode = workspaceControlOperationSchema.parse(inputMode);
      const execution = await actionRepository(transaction, ownerId).workspaceExecution(operation);
      const workspace = await find(operation.identity.workspaceId, true);
      if (!execution || !workspace || workspace.state === "retired")
        throw new Error("Execution unavailable.");
      return capabilityRepository(transaction, ownerId).issue({
        kind: "worker",
        subjectId,
        taskId: operation.taskId,
        revision: operation.revision,
        generation: operation.generation,
        operation: mode,
        resourceId: workspace.id,
        resourceRevision: workspace.revision,
        executionId: operation.operationId,
        credential: null,
      });
    },
    async authorize(input: ServiceRequest, inputOperation: WorkspaceOperation) {
      const operation = workspaceOperationSchema.parse(inputOperation);
      if (operation.kind !== "workspace:inspect") return null;
      await lock();
      return authorizeWorker(input, operation);
    },
    async issueCli(
      input: ServiceRequest,
      inputCommand: WorkspaceCommand,
      environment: CliAuthority["environment"],
    ) {
      const command = workspaceCommandSchema.parse(inputCommand);
      await lock();
      const grant = await authorizeWorker(input, command.operation);
      if (!grant || !(await actionRepository(transaction, ownerId).authorizeWorkspace(command)))
        return null;
      const operation = command.operation;
      const credential = await capabilityRepository(transaction, ownerId).issue({
        kind: "workspace",
        subjectId: operation.identity.workspaceId,
        resourceId: operation.identity.workspaceId,
        resourceRevision: grant.workspaceRevision,
        taskId: operation.taskId,
        revision: operation.revision,
        generation: operation.generation,
        operation: "gateway:read",
        credential: null,
      });
      return cliAuthoritySchema.parse({
        version: 1,
        environment,
        workspaceId: operation.identity.workspaceId,
        token: credential.token,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    },
    async authorizeCommand(input: ServiceRequest, inputCommand: WorkspaceCommand) {
      const command = workspaceCommandSchema.parse(inputCommand);
      await lock();
      const grant = await authorizeWorker(input, command.operation);
      if (!grant || !(await actionRepository(transaction, ownerId).authorizeWorkspace(command)))
        return null;
      return grant;
    },
    async authorizeControl(input: ServiceRequest, inputOperation: WorkspaceOperation) {
      const request = serviceRequestSchema.parse(input);
      const operation = workspaceOperationSchema.parse(inputOperation);
      if (!workspaceControlOperationSchema.safeParse(request.operation).success) return null;
      await lock();
      const authority = await capabilityRepository(transaction, ownerId).authenticate(request);
      if (
        !authority ||
        authority.executionId !== operation.operationId ||
        authority.resourceId !== operation.identity.workspaceId ||
        !(await actionRepository(transaction, ownerId).workspaceExecution(operation))
      )
        return null;
      return {
        version: 1 as const,
        allowed: true as const,
        operation,
        workspaceRevision: authority.resourceRevision,
      };
    },
  };
}

export type WorkspaceRepository = ReturnType<typeof workspaceRepository>;
