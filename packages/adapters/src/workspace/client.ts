import { canonicalJson } from "@winston/contracts/json";
import {
  commandOutputChannelSchema,
  commandResultSchema,
  type CommandOutputChannel,
} from "@winston/contracts/commands";
import { serviceRequestSchema, type ServiceRequest } from "@winston/contracts/capabilities";
import {
  workspaceCommandSchema,
  type WorkspaceCommand,
} from "@winston/contracts/workspace-commands";
import {
  workspaceOperationSchema,
  workspaceRecordSchema,
  type WorkspaceOperation,
} from "@winston/contracts/workspace";

async function boundedJson(response: Response) {
  const reader = (response.body as ReadableStream<Uint8Array> | null)?.getReader();
  if (!reader) throw new Error("Workspace response missing.");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > 16_384) throw new Error("Workspace response exceeded limit.");
      chunks.push(item.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

export function createWorkspaceClient(origin: string) {
  const url = new URL(origin);
  if (
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        (url.hostname === "127.0.0.1" || url.hostname.endsWith(".flycast"))
      )) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("Invalid trusted workspace origin.");

  async function send(
    mode: string,
    credential: ServiceRequest,
    operation: WorkspaceOperation,
    body: WorkspaceOperation | WorkspaceCommand,
    signal?: AbortSignal,
  ) {
    const request = serviceRequestSchema.parse(credential);
    const expected =
      mode === "cancel"
        ? "workspace:cancel"
        : ["start", "renew"].includes(mode)
          ? "workspace:execute"
          : "workspace:observe";
    if (
      request.kind !== "worker" ||
      request.operation !== expected ||
      request.resourceId !== operation.identity.workspaceId
    )
      throw new Error("Workspace capability scope mismatch.");
    const deadline = new AbortController();
    const timer = setTimeout(() => {
      deadline.abort();
    }, 15_000);
    try {
      const response = await fetch(new URL(`/v1/commands/${mode}`, url), {
        method: "POST",
        redirect: "error",
        credentials: "omit",
        signal: signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal,
        headers: {
          Authorization: `Bearer ${request.token}`,
          "X-Winston-Worker": request.subjectId,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Workspace request failed (${String(response.status)}).`);
      }
      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  async function record(
    mode: string,
    credential: ServiceRequest,
    operation: WorkspaceOperation,
    body: WorkspaceOperation | WorkspaceCommand,
    signal?: AbortSignal,
  ) {
    const timeout = AbortSignal.timeout(15_000);
    const response = await send(
      mode,
      credential,
      operation,
      body,
      signal ? AbortSignal.any([signal, timeout]) : timeout,
    );
    const result = workspaceRecordSchema.parse(await boundedJson(response));
    if (canonicalJson(result.request) !== canonicalJson(operation))
      throw new Error("Workspace operation mismatch.");
    return result;
  }

  return {
    start(credential: ServiceRequest, input: WorkspaceCommand, signal?: AbortSignal) {
      const command = workspaceCommandSchema.parse(input);
      // Never retry a dispatch automatically: a transport failure may follow a successful start.
      return record("start", credential, command.operation, command, signal);
    },
    renew(credential: ServiceRequest, input: WorkspaceCommand, signal?: AbortSignal) {
      const command = workspaceCommandSchema.parse(input);
      return record("renew", credential, command.operation, command, signal);
    },
    control(credential: ServiceRequest, input: WorkspaceOperation, signal?: AbortSignal) {
      const operation = workspaceOperationSchema.parse(input);
      if (
        credential.operation !== "workspace:observe" &&
        credential.operation !== "workspace:cancel"
      )
        throw new Error("Workspace recovery scope required.");
      return record(
        credential.operation === "workspace:cancel" ? "cancel" : "status",
        credential,
        operation,
        operation,
        signal,
      );
    },
    async output(
      credential: ServiceRequest,
      input: WorkspaceOperation,
      inputChannel: CommandOutputChannel,
      signal?: AbortSignal,
    ) {
      const operation = workspaceOperationSchema.parse(input);
      const channel = commandOutputChannelSchema.parse(inputChannel);
      const state = await record("status", credential, operation, operation, signal);
      if (state.outcome?.state !== "completed") throw new Error("Command output is not complete.");
      const metadata = commandResultSchema.parse(JSON.parse(state.outcome.result))[channel];
      const response = await send(channel, credential, operation, operation, signal);
      if (
        !response.body ||
        response.headers.get("Content-Length") !== String(metadata.bytes) ||
        response.headers.get("X-Winston-Output-SHA256") !== metadata.sha256
      ) {
        await response.body?.cancel();
        throw new Error("Command output metadata mismatch.");
      }
      return { metadata, stream: response.body };
    },
  };
}
