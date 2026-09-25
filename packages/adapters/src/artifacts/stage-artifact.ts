import { createHash } from "node:crypto";
import {
  artifactStageReceiptSchema,
  maximumPublicationSize,
  type ArtifactStageRequest,
  type ArtifactTransfer,
} from "@winston/contracts/artifacts";
import { cliResultSchema, type CliResult } from "@winston/contracts/cli";
import type { ServiceRequest } from "@winston/contracts/capabilities";
import type { createDatabase } from "../database";
import type { createArtifactReader } from "./read";

async function receipt(response: Response) {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error("Artifact receiver unavailable.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      const value: unknown = item.value;
      if (!(value instanceof Uint8Array)) throw new Error("Invalid artifact receipt stream.");
      size += value.byteLength;
      if (size > 4096) throw new Error("Invalid artifact receipt.");
      chunks.push(value);
    }
    return artifactStageReceiptSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function staged(transfer: ArtifactTransfer, path: string): CliResult {
  return cliResultSchema.parse({
    version: 1,
    status: "ok",
    data: {
      artifactId: transfer.artifactId,
      revision: transfer.artifactRevision,
      workspaceId: transfer.workspaceId,
      path,
      size: transfer.size,
      sha256: transfer.sha256,
      trust: "untrusted_external_content",
    },
  });
}

export function createArtifactStager(options: {
  database: ReturnType<typeof createDatabase>;
  read: ReturnType<typeof createArtifactReader>;
  send?: (url: URL, init: RequestInit) => Promise<Response>;
}) {
  const { database, read } = options;
  return async (
    credential: ServiceRequest,
    request: ArtifactStageRequest,
    signal: AbortSignal,
  ): Promise<CliResult> => {
    const authority = await database.authenticateService(credential);
    if (authority?.operation !== "gateway:control")
      return { version: 1, status: "denied", message: "Task staging authority is unavailable." };
    const ownerId = authority.ownerId;
    const start = await database.transaction(ownerId, ({ artifactTransfers }) =>
      artifactTransfers.begin(credential, request),
    );
    if (start.status === "denied" || start.status === "unavailable")
      return {
        version: 1,
        status: start.status,
        message: "The source artifact or destination workspace is unavailable for this task.",
      };
    if (start.status === "waiting" || start.status === "unknown")
      return {
        version: 1,
        status: start.status,
        referenceId: start.actionId,
        message:
          start.status === "waiting"
            ? "Waiting for exact workspace file approval. Resume with the same key and artifact."
            : "This transfer is still unresolved. Reuse the same key; do not start a different transfer.",
      };
    if (start.status === "staged") return staged(start.transfer, start.receipt.path);
    const { token, transfer } = start;
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(50_000)]);
    try {
      deadline.throwIfAborted();
      if (!(await database.authenticateArtifactTransfer(token)))
        throw new Error("Transfer authority changed.");
      const file = await read(ownerId, transfer.artifactId, maximumPublicationSize, deadline);
      if (
        !file ||
        file.artifact.id !== transfer.artifactId ||
        file.artifact.revision !== transfer.artifactRevision ||
        file.artifact.metadata.size !== transfer.size ||
        file.artifact.metadata.sha256 !== transfer.sha256 ||
        file.bytes.length !== transfer.size ||
        createHash("sha256").update(file.bytes).digest("hex") !== transfer.sha256
      )
        throw new Error("Artifact identity changed.");
      if (!(await database.authenticateArtifactTransfer(token)))
        throw new Error("Transfer authority changed.");
      deadline.throwIfAborted();
      const response = await (options.send ?? fetch)(new URL("/v1/artifacts", start.origin), {
        method: "POST",
        redirect: "error",
        credentials: "omit",
        signal: deadline,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/octet-stream",
          "X-Winston-Transfer": Buffer.from(JSON.stringify(transfer)).toString("base64url"),
        },
        body: file.bytes,
      });
      const observed = await receipt(response);
      deadline.throwIfAborted();
      const completed = await database.transaction(ownerId, ({ artifactTransfers }) =>
        artifactTransfers.complete(token, transfer, observed),
      );
      if (!completed) throw new Error("Transfer completion authority changed.");
      return staged(transfer, completed.path);
    } catch {
      await database
        .transaction(ownerId, ({ artifactTransfers }) => artifactTransfers.retry(token))
        .catch(() => undefined);
      return {
        version: 1,
        status: "unknown",
        referenceId: start.actionId,
        message:
          "Workspace staging was not confirmed. Reuse the same key to verify this immutable transfer without fetching Gmail again.",
      };
    }
  };
}
