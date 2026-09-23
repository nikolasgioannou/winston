import { randomUUID } from "node:crypto";
import type { createDatabase } from "../database";
import { commandResultSchema } from "@winston/contracts/commands";
import { canonicalJson } from "@winston/contracts/json";
import { createWorkspaceClient } from "./client";
import { workspaceOperation } from "./operation";

export function createWorkspaceCancellation(options: {
  database: Pick<ReturnType<typeof createDatabase>, "transaction">;
  connect?: (origin: string) => Pick<ReturnType<typeof createWorkspaceClient>, "control">;
}) {
  const { database } = options;
  const connect = options.connect ?? createWorkspaceClient;
  return async (ownerId: string, afterId: string | undefined, signal: AbortSignal) => {
    const actions = await database.transaction(ownerId, ({ actions }) =>
      actions.stoppedWorkspaceCommands(afterId),
    );
    await Promise.all(
      actions.map(async (action) => {
        try {
          signal.throwIfAborted();
          const operation = workspaceOperation(ownerId, action);
          const workerId = randomUUID();
          const destination = await database.transaction(
            ownerId,
            async ({ workspaceRuntimes, workspaces }) => {
              const runtime = await workspaceRuntimes.resolve(operation.identity.workspaceId);
              if (!runtime) return null;
              const grant = await workspaces.issueControl(workerId, operation, "workspace:cancel");
              return { runtime, grant };
            },
          );
          if (!destination) return;
          const record = await connect(destination.runtime.origin).control(
            {
              token: destination.grant.token,
              kind: "worker",
              subjectId: workerId,
              resourceId: operation.identity.workspaceId,
              operation: "workspace:cancel",
            },
            operation,
            signal,
          );
          if (canonicalJson(record.request) !== canonicalJson(operation)) return;
          if (record.state === "running" || record.state === "unknown" || !record.outcome) return;
          const result =
            record.outcome.state === "completed"
              ? commandResultSchema.parse(JSON.parse(record.outcome.result))
              : null;
          await database.transaction(ownerId, ({ actions }) =>
            actions.reconcileWorkspace(operation, {
              state: result?.exitCode === 0 && result.reason === "exited" ? "succeeded" : "failed",
              detail: result ? JSON.stringify(result) : JSON.stringify(record.outcome),
              providerReference: operation.operationId,
            }),
          );
        } catch {
          // An unreachable or ambiguous operation remains unresolved for the next pass.
          // Cancellation is idempotent; this path never starts or renews execution.
        }
      }),
    );
    return actions.length === 4 ? actions.at(-1)?.id : undefined;
  };
}
