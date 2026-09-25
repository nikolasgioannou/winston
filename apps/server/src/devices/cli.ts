import { DeviceActionPreparationError, type createDatabase } from "@winston/adapters/database";
import {
  cliDeviceRequestSchema,
  deviceCommandTimeoutMs,
  type CliDeviceRequest,
  type CliResult,
} from "@winston/contracts/cli";
import type { ServiceRequest } from "@winston/contracts/capabilities";
import type { DeviceServerIdentity } from "@winston/contracts/device-registry";
import type { createDeviceDispatcher } from "./dispatch";
import { createDeviceRequestRouting } from "./routing";
import { deviceCommandResult } from "./result";

export function createDeviceCli(options: {
  database: ReturnType<typeof createDatabase>;
  dispatch: ReturnType<typeof createDeviceDispatcher>;
  server: DeviceServerIdentity;
}) {
  const { database } = options;
  const route = createDeviceRequestRouting(database, options.server);
  const result = (
    status: Exclude<CliResult["status"], "ok">,
    message: string,
    referenceId?: string,
  ) => Response.json({ version: 1, status, message, ...(referenceId ? { referenceId } : {}) });
  return async (
    credential: ServiceRequest,
    input: CliDeviceRequest,
    headers: Headers,
    signal: AbortSignal,
  ): Promise<Response> => {
    const request = cliDeviceRequestSchema.parse(input);
    const identity = await database.authenticateService(credential);
    const expected = request.command === "devices.command" ? "gateway:control" : "gateway:read";
    if (!identity || identity.operation !== expected)
      return result("denied", "Task authority is unavailable or expired.");
    signal.throwIfAborted();
    const read = (id: string, after = -1) =>
      database.transaction(identity.ownerId, async (scope): Promise<CliResult> => {
        const authority = await scope.capabilities.authenticate(credential);
        if (!authority || authority.operation !== expected)
          return {
            version: 1,
            status: "denied",
            message: "Task read authority is unavailable or expired.",
          };
        return deviceCommandResult(scope, authority.taskId, id, after);
      });
    if (request.command === "devices.result")
      return Response.json(await read(request.id, request.after));
    const prepared = await database
      .transaction(identity.ownerId, async (scope) => {
        const authority = await scope.capabilities.authenticate(credential);
        if (!authority || authority.operation !== "gateway:control") return null;
        const task = {
          id: authority.taskId,
          revision: authority.revision,
          generation: authority.generation,
        };
        const action = await scope.deviceActions.prepare(
          task,
          request.key,
          request.id,
          request.operation,
        );
        const policy = await scope.authorization.evaluate(
          action.request.authorization,
          action.snapshot ?? undefined,
        );
        if (policy.decision === "deny") return { action, task, denied: true };
        if (action.state === "pending") {
          const pending = await scope.actions.expirePending(action.id);
          if (pending?.state !== "pending") return { action: pending ?? action, task };
          await scope.tasks.finishStep(task.id, task.revision, task.generation, {
            state: "waiting",
            blocker: {
              kind: "approval",
              referenceId: action.id,
              detail: "Waiting for permission to run this command on the selected computer.",
            },
          });
        }
        return { action, task };
      })
      .catch((error: unknown) => {
        if (error instanceof DeviceActionPreparationError)
          return error.reason === "conflict"
            ? result(
                "invalid_input",
                "This key belongs to a different device command. Keep its original target and arguments.",
              )
            : result("unavailable", "The computer is unavailable to this task.");
        throw error;
      });
    if (prepared instanceof Response) return prepared;
    if (!prepared) return result("denied", "Task control authority is unavailable or expired.");
    const { action, task } = prepared;
    if ("denied" in prepared && prepared.denied)
      return result("denied", "This command is no longer permitted.", action.id);
    if (action.state === "pending")
      return result(
        "approval_required",
        "Waiting for approval of this exact command. Resume with the same key and arguments.",
        action.id,
      );
    if (action.state === "denied" || action.state === "invalidated")
      return result("denied", "This command is no longer permitted.", action.id);
    if (action.state !== "approved") return Response.json(await read(action.id));
    const destination = await route(credential, request.id, headers);
    if (destination.kind === "response") return destination.response;
    if (
      destination.ownerId !== identity.ownerId ||
      destination.task.id !== task.id ||
      destination.task.revision !== task.revision ||
      destination.task.generation !== task.generation
    )
      return result("denied", "Task authority changed before dispatch.", action.id);
    const ready = await database.transaction(identity.ownerId, ({ deviceSessions }) =>
      deviceSessions.supports(destination.session, "command"),
    );
    if (!ready)
      return result("unavailable", "The computer is not ready to run commands.", action.id);
    signal.throwIfAborted();
    const dispatched = await options
      .dispatch(identity.ownerId, {
        id: action.id,
        hash: action.hash,
        task,
        message: {
          version: 1,
          ...destination.session,
          messageId: crypto.randomUUID(),
          correlationId: crypto.randomUUID(),
          payload: {
            kind: "execute",
            executionId: action.operationId,
            taskId: task.id,
            taskRevision: task.revision,
            deadline: Date.now() + deviceCommandTimeoutMs,
            operation: request.operation,
          },
        },
      })
      .catch(() => null);
    if (!dispatched)
      return result(
        "unknown",
        "The command outcome could not be verified. Inspect its result before retrying.",
        action.id,
      );
    if (dispatched.status === "uncertain")
      return result(
        "unknown",
        "The command may have started. Inspect its result before retrying.",
        action.id,
      );
    if (dispatched.status === "busy")
      return result(
        "waiting",
        "The computer is busy. Retry this same key after its current operation finishes.",
        action.id,
      );
    if (dispatched.status === "unavailable")
      return result("unavailable", "The computer's connection changed before dispatch.", action.id);
    if (dispatched.status === "denied")
      return result("denied", "Command authority expired or changed before dispatch.", action.id);
    const receipt = await read(action.id).catch(() => null);
    return receipt?.status === "ok"
      ? Response.json(receipt)
      : result(
          "unknown",
          "The command was dispatched but its result is unavailable. Inspect this operation before retrying.",
          action.id,
        );
  };
}
