import { createHash } from "node:crypto";
import type { ActionRecord } from "@winston/contracts/actions";
import { commandInputSchema } from "@winston/contracts/commands";
import { canonicalJson } from "@winston/contracts/json";
import type { WorkspaceCommand } from "@winston/contracts/workspace-commands";

export function workspaceOperation(
  ownerId: string,
  action: ActionRecord,
): WorkspaceCommand["operation"] {
  if (!action.dispatchTask) throw new Error("Action has no committed dispatch.");
  return {
    version: 1,
    identity: { ownerId, workspaceId: action.request.authorization.target.id },
    operationId: action.operationId,
    taskId: action.dispatchTask.id,
    revision: action.dispatchTask.revision,
    generation: action.dispatchTask.generation,
    kind: "command:execute",
    inputHash: createHash("sha256")
      .update(canonicalJson(commandInputSchema.parse(action.request.arguments)))
      .digest("hex"),
  };
}
