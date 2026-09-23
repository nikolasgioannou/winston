import { randomUUID } from "node:crypto";
import type { ActionRecord, ActionTask } from "@winston/contracts/actions";
import type { ServiceRequest } from "@winston/contracts/capabilities";
import { commandInputSchema, commandResultSchema } from "@winston/contracts/commands";
import { canonicalJson } from "@winston/contracts/json";
import type { WorkspaceRecord } from "@winston/contracts/workspace";
import type { WorkspaceCommand } from "@winston/contracts/workspace-commands";
import type { createDatabase } from "../database";
import { createWorkspaceClient } from "./client";
import { workspaceOperation as operation } from "./operation";

type Status =
  | { kind: "finished"; action: ActionRecord }
  | { kind: "blocked"; actionId: string; reason: "approval" | "unavailable" | "unknown" | "stale" }
  | { kind: "running"; actionId: string };

export type WorkspaceSession = {
  kind: "session";
  actionId: string;
  poll(signal: AbortSignal): Promise<Status>;
};

function terminal(action: ActionRecord): Status | undefined {
  if (action.state === "pending")
    return { kind: "blocked", actionId: action.id, reason: "approval" };
  if (["denied", "invalidated", "succeeded", "failed"].includes(action.state))
    return { kind: "finished", action };
  return undefined;
}

export function createWorkspaceSessions(options: {
  database: Pick<ReturnType<typeof createDatabase>, "transaction">;
  connect?: (
    origin: string,
  ) => Pick<ReturnType<typeof createWorkspaceClient>, "start" | "renew" | "control">;
}) {
  const { database } = options;
  const connect = options.connect ?? createWorkspaceClient;
  return {
    async open(
      input: { ownerId: string; task: ActionTask; modelStepId: string; callId: string },
      signal: AbortSignal,
    ): Promise<Status | WorkspaceSession> {
      signal.throwIfAborted();
      const workerId = randomUUID();
      const prepared = await database.transaction(input.ownerId, async (scope) => {
        let action = await scope.taskSteps.prepareWorkspace(
          input.task,
          input.modelStepId,
          input.callId,
        );
        const done = terminal(action);
        if (done) return { status: done };
        const runtime = await scope.workspaceRuntimes.resolve(
          action.request.authorization.target.id,
        );
        if (!runtime)
          return {
            status: { kind: "blocked", actionId: action.id, reason: "unavailable" } as const,
          };
        let dispatch: WorkspaceCommand | undefined;
        let execute: ServiceRequest | undefined;
        const credential = (
          token: string,
          operation: ServiceRequest["operation"],
        ): ServiceRequest => ({
          token,
          kind: "worker",
          subjectId: workerId,
          resourceId: runtime.workspaceId,
          operation,
        });
        if (action.state === "approved") {
          const claimed = await scope.actions.claim(action.id, action.hash, input.task);
          if (!claimed?.claimed)
            return {
              status:
                terminal(claimed?.action ?? action) ??
                ({ kind: "blocked", actionId: action.id, reason: "stale" } as const),
            };
          action = claimed.action;
          dispatch = {
            operation: operation(input.ownerId, action),
            input: commandInputSchema.parse(action.request.arguments),
            dispatch: { id: action.id, token: claimed.token },
          };
          const grant = await scope.workspaces.issueExecution({
            workerId,
            workspaceId: runtime.workspaceId,
            taskId: input.task.id,
            revision: input.task.revision,
            generation: input.task.generation,
          });
          execute = credential(grant.token, "workspace:execute");
        }
        return {
          action,
          runtime,
          dispatch,
          execute,
          credential,
          operation: operation(input.ownerId, action),
        };
      });
      if (prepared.status) return prepared.status;
      const { action, runtime, dispatch, execute, credential } = prepared;
      const execution = prepared.operation;
      const client = connect(runtime.origin);
      let initial: WorkspaceRecord | undefined;
      // A failed response may follow a successful start. Retain the operation and observe it;
      // never issue another start, including after this in-memory session is lost.
      if (dispatch && execute && !signal.aborted) {
        try {
          initial = await client.start(execute, dispatch, signal);
        } catch {
          /* Reconcile by operation below. */
        }
      }
      async function accept(record: WorkspaceRecord): Promise<Status> {
        if (canonicalJson(record.request) !== canonicalJson(execution))
          return { kind: "blocked", actionId: action.id, reason: "unknown" };
        if (record.state === "running") return { kind: "running", actionId: action.id };
        if (!record.outcome || record.state === "unknown")
          return { kind: "blocked", actionId: action.id, reason: "unknown" };
        const result =
          record.outcome.state === "completed"
            ? commandResultSchema.parse(JSON.parse(record.outcome.result))
            : null;
        const saved = await database.transaction(input.ownerId, ({ actions }) =>
          actions.reconcileWorkspace(execution, {
            state: result?.exitCode === 0 && result.reason === "exited" ? "succeeded" : "failed",
            detail: result ? JSON.stringify(result) : JSON.stringify(record.outcome),
            providerReference: execution.operationId,
          }),
        );
        return saved
          ? { kind: "finished", action: saved }
          : { kind: "blocked", actionId: action.id, reason: "unknown" };
      }
      return {
        kind: "session",
        actionId: action.id,
        async poll(pollSignal) {
          if (pollSignal.aborted) return { kind: "blocked", actionId: action.id, reason: "stale" };
          if (initial) {
            const record = initial;
            initial = undefined;
            return accept(record);
          }
          try {
            const grant = await database.transaction(input.ownerId, async (scope) => {
              const current = await scope.taskSteps.prepareWorkspace(
                input.task,
                input.modelStepId,
                input.callId,
              );
              const done = terminal(current);
              if (done) return { status: done };
              const destination = await scope.workspaceRuntimes.resolve(runtime.workspaceId);
              if (
                destination?.origin !== runtime.origin ||
                destination.revision !== runtime.revision
              )
                return {
                  status: { kind: "blocked", actionId: action.id, reason: "unavailable" } as const,
                };
              const observe = await scope.workspaces.issueControl(
                workerId,
                prepared.operation,
                "workspace:observe",
              );
              const renewal = dispatch
                ? await scope.workspaces.issueExecution({
                    workerId,
                    workspaceId: runtime.workspaceId,
                    taskId: input.task.id,
                    revision: input.task.revision,
                    generation: input.task.generation,
                  })
                : null;
              return {
                observe: credential(observe.token, "workspace:observe"),
                renewal: renewal ? credential(renewal.token, "workspace:execute") : null,
              };
            });
            if (grant.status) return grant.status;
            if (dispatch && grant.renewal) {
              try {
                return await accept(await client.renew(grant.renewal, dispatch, pollSignal));
              } catch {
                /* Observe even when execution authority was revoked. */
              }
            }
            return await accept(
              await client.control(grant.observe, prepared.operation, pollSignal),
            );
          } catch {
            return {
              kind: "blocked",
              actionId: action.id,
              reason: "unknown",
            };
          }
        },
      };
    },
  };
}
