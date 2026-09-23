import { sql } from "drizzle-orm";
import { cliRequestSchema, type CliRequest, type CliResult } from "@winston/contracts/cli";
import type { ServiceRequest } from "@winston/contracts/capabilities";
import type { DatabaseTransaction } from "./owners";
import { capabilityRepository } from "./capabilities";
import { connectionRepository } from "./connections";
import { deviceRepository } from "./devices";
import { actionRepository } from "./actions";
import { handoffRepository } from "./handoffs";
import { executeScheduleCommand } from "./cli-schedules";
import type { CliScheduleRequest } from "@winston/contracts/cli";

export function cliRepository(transaction: DatabaseTransaction, ownerId: string) {
  return {
    schedule: (credential: ServiceRequest, request: CliScheduleRequest) =>
      executeScheduleCommand(transaction, ownerId, credential, request),
    async connect(
      credential: ServiceRequest,
      input: Extract<CliRequest, { command: "accounts.connect" }>,
    ): Promise<CliResult> {
      const request = cliRequestSchema.parse(input);
      if (request.command !== "accounts.connect") throw new Error("Invalid connection request.");
      await transaction.execute(
        sql`SELECT id FROM winston.owners WHERE id = ${ownerId}::uuid FOR UPDATE`,
      );
      const authority = await capabilityRepository(transaction, ownerId).authenticate(credential);
      if (!authority || authority.operation !== "gateway:control")
        return {
          version: 1,
          status: "denied",
          message: "Task control authority is unavailable or expired.",
        };
      const handoff = await handoffRepository(transaction, ownerId).prepare({
        key: `cli:${authority.taskId}:${request.key}`,
        task: {
          id: authority.taskId,
          revision: authority.revision,
          generation: authority.generation,
        },
        target: { kind: "connection", service: request.service, connectionId: request.id ?? null },
        detail: request.detail,
      });
      if (handoff.state === "completed")
        return {
          version: 1,
          status: "ok",
          data: { handoffId: handoff.id, connectionId: handoff.resolutionId },
        };
      return {
        version: 1,
        status: "waiting",
        referenceId: handoff.id,
        message: "Waiting for the owner to complete account setup.",
      };
    },
    async cancel(credential: ServiceRequest, inputId: string): Promise<CliResult> {
      await transaction.execute(
        sql`SELECT id FROM winston.owners WHERE id = ${ownerId}::uuid FOR UPDATE`,
      );
      const authority = await capabilityRepository(transaction, ownerId).authenticate(credential);
      if (!authority || authority.operation !== "gateway:control")
        return {
          version: 1,
          status: "denied",
          message: "Task control authority is unavailable or expired.",
        };
      const action = await actionRepository(transaction, ownerId).requestCancellation(
        inputId,
        {
          id: authority.taskId,
          revision: authority.revision,
          generation: authority.generation,
        },
        authority.resourceId,
      );
      if (!action)
        return {
          version: 1,
          status: "denied",
          message: "Operation unavailable to this task and workspace.",
        };
      if (["dispatching", "unknown"].includes(action.state))
        return {
          version: 1,
          status: "waiting",
          message: "Cancellation requested; the execution outcome is not yet confirmed.",
          referenceId: action.id,
        };
      return {
        version: 1,
        status: "ok",
        data: { id: action.id, state: action.state, outcome: action.outcome },
      };
    },
    async execute(credential: ServiceRequest, input: CliRequest): Promise<CliResult> {
      const request = cliRequestSchema.parse(input);
      await transaction.execute(
        sql`SELECT id FROM winston.owners WHERE id = ${ownerId}::uuid FOR UPDATE`,
      );
      const authority = await capabilityRepository(transaction, ownerId).authenticate(credential);
      if (!authority || authority.operation !== "gateway:read")
        return {
          version: 1,
          status: "denied",
          message: "Task authority is unavailable or expired.",
        };
      if (request.command === "accounts.list") {
        const accounts = await connectionRepository(transaction, ownerId).list();
        return {
          version: 1,
          status: "ok",
          data: accounts.slice(0, 100).map(({ id, service, email, status, revision }) => ({
            id,
            service,
            email,
            status,
            revision,
          })),
        };
      }
      if (request.command === "devices.list") {
        const devices = await deviceRepository(transaction, ownerId).list();
        return {
          version: 1,
          status: "ok",
          data: devices.filter((device) => !device.revoked).slice(0, 100),
        };
      }
      if (request.command === "devices.inspect") {
        const device = await deviceRepository(transaction, ownerId).find(request.id);
        return device && !device.revoked
          ? { version: 1, status: "ok", data: device }
          : { version: 1, status: "denied", message: "Device unavailable to this task." };
      }
      if (request.command === "operations.inspect") {
        const action = await actionRepository(transaction, ownerId).find(request.id);
        if (!action || action.request.task.id !== authority.taskId)
          return { version: 1, status: "denied", message: "Operation unavailable to this task." };
        return {
          version: 1,
          status: "ok",
          data: {
            id: action.id,
            operationId: action.operationId,
            state: action.state,
            outcome: action.outcome,
            cancellationRequested: await actionRepository(
              transaction,
              ownerId,
            ).cancellationRequested(action.id),
          },
        };
      }
      return {
        version: 1,
        status: "denied",
        message: "This credential does not authorize cancellation.",
      };
    },
  };
}
