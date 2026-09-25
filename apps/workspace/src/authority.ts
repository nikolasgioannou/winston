import {
  workspaceAuthorizationSchema,
  type WorkspaceOperation,
} from "@winston/contracts/workspace";
import type { ServiceRequest } from "@winston/contracts/capabilities";
import { canonicalJson } from "@winston/contracts/json";
import type { WorkspaceCommand } from "@winston/contracts/workspace-commands";
import { boundedJson } from "./http-body";
import { cliAuthoritySchema } from "@winston/contracts/cli";
import { createTransferAuthority } from "./transfer-authority";

export function createWorkspaceAuthority(origin: string) {
  const url = new URL(origin);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1")) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error("Workspace authority requires an HTTPS origin or loopback development server.");
  }

  async function authorize(
    credential: ServiceRequest,
    operation: WorkspaceOperation,
    endpoint: string,
    body: WorkspaceOperation | WorkspaceCommand,
  ) {
    const response = await fetch(
      new URL(`/api/tasks/workspaces/${operation.identity.workspaceId}/${endpoint}`, url),
      {
        method: "POST",
        redirect: "error",
        credentials: "omit",
        signal: AbortSignal.timeout(5_000),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${credential.token}`,
          "X-Winston-Worker": credential.subjectId,
        },
        body: JSON.stringify(body),
      },
    );
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      return false;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Workspace authority unavailable.");
    }
    const result = workspaceAuthorizationSchema.parse(await boundedJson(response.body, 16_384));
    return canonicalJson(result.operation) === canonicalJson(operation);
  }
  return {
    ...createTransferAuthority(url),
    async gateway(credential: ServiceRequest, command: WorkspaceCommand) {
      if (credential.operation !== "workspace:execute")
        throw new Error("Invalid command authority.");
      const response = await fetch(
        new URL(
          `/api/tasks/workspaces/${command.operation.identity.workspaceId}/authorize-cli`,
          url,
        ),
        {
          method: "POST",
          redirect: "error",
          credentials: "omit",
          signal: AbortSignal.timeout(5000),
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${credential.token}`,
            "X-Winston-Worker": credential.subjectId,
            "X-Winston-CLI-Control": "1",
          },
          body: JSON.stringify(command),
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("CLI authority unavailable.");
      }
      const result = cliAuthoritySchema.parse(await boundedJson(response.body, 4096));
      if (result.workspaceId !== command.operation.identity.workspaceId)
        throw new Error("CLI workspace mismatch.");
      return result;
    },
    inspect: (credential: ServiceRequest, operation: WorkspaceOperation) => {
      if (credential.operation !== "workspace:execute" || operation.kind !== "workspace:inspect")
        return Promise.resolve(false);
      return authorize(credential, operation, "authorize", operation);
    },
    command(credential: ServiceRequest, command: WorkspaceCommand) {
      if (credential.operation !== "workspace:execute") return Promise.resolve(false);
      return authorize(credential, command.operation, "authorize-command", command);
    },
    control(credential: ServiceRequest, operation: WorkspaceOperation) {
      if (
        credential.operation !== "workspace:observe" &&
        credential.operation !== "workspace:cancel"
      )
        return Promise.resolve(false);
      const endpoint =
        credential.operation === "workspace:observe" ? "authorize-observe" : "authorize-cancel";
      return authorize(credential, operation, endpoint, operation);
    },
  };
}
