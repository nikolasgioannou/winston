import {
  workspaceAuthorizationSchema,
  type WorkspaceOperation,
} from "@winston/contracts/workspace";
import type { ServiceRequest } from "@winston/contracts/capabilities";
import { boundedJson } from "./http-body";

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

  return async (credential: ServiceRequest, operation: WorkspaceOperation) => {
    const response = await fetch(
      new URL(`/api/tasks/workspaces/${operation.identity.workspaceId}/authorize`, url),
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
        body: JSON.stringify(operation),
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
    return JSON.stringify(result.operation) === JSON.stringify(operation);
  };
}
