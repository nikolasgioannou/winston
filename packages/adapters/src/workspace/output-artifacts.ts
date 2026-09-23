import type { ServiceRequest } from "@winston/contracts/capabilities";
import type { CommandOutputChannel } from "@winston/contracts/commands";
import type { WorkspaceOperation } from "@winston/contracts/workspace";
import type { createArtifactService } from "../artifacts";
import type { createWorkspaceClient } from "./client";

async function* chunks(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) return;
      yield item.value;
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

export async function archiveCommandOutput(options: {
  ownerId: string;
  credential: ServiceRequest;
  operation: WorkspaceOperation;
  channel: CommandOutputChannel;
  client: Pick<ReturnType<typeof createWorkspaceClient>, "output">;
  artifacts: Pick<ReturnType<typeof createArtifactService>, "upload">;
  signal?: AbortSignal;
}) {
  if (options.ownerId !== options.operation.identity.ownerId)
    throw new Error("Output owner mismatch.");
  const output = await options.client.output(
    options.credential,
    options.operation,
    options.channel,
    options.signal,
  );
  try {
    return await options.artifacts.upload(
      options.ownerId,
      `command:${options.operation.operationId}:${options.channel}`,
      {
        name: `${options.channel}.log`,
        mediaType: "application/octet-stream",
        source: { kind: "workspace", reference: options.operation.operationId },
        size: output.metadata.bytes,
        sha256: output.metadata.sha256,
      },
      chunks(output.stream),
      options.signal,
    );
  } finally {
    // Idempotent catalog hits may return without consuming the new response body.
    if (!output.stream.locked) await output.stream.cancel();
  }
}
