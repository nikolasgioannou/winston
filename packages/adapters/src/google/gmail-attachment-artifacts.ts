import { createHash } from "node:crypto";
import { artifactMetadataSchema } from "@winston/contracts/artifacts";
import type { CliReadRequest, CliResult } from "@winston/contracts/cli";
import type { ResolvedTarget } from "@winston/contracts/connection-targets";
import type { createArtifactService } from "../artifacts";
import { createGmailReader } from "./gmail";
import type { GoogleReadOptions } from "./read-request";
import { gmailAttachmentResult } from "./gmail-attachment-result";
import { artifactDisplayName } from "../artifacts/display-name";

export type GmailAttachmentRead = Extract<CliReadRequest, { command: "gmail.attachment" }>;
export type AttachmentStore = Pick<
  ReturnType<typeof createArtifactService>,
  "upload" | "reconcile"
>;

export async function captureGmailAttachment(options: {
  read: GoogleReadOptions;
  artifacts: AttachmentStore;
  ownerId: string;
  request: GmailAttachmentRead;
  target: ResolvedTarget;
  actionId: string;
  signal: AbortSignal;
}): Promise<CliResult> {
  const { read, artifacts, ownerId, request, target, actionId, signal } = options;
  const current = async () => {
    signal.throwIfAborted();
    if (
      !(await read.authorize?.()) ||
      !(await read.approved?.({
        target: { kind: "connection", id: target.connectionId, resource: null },
        operation: "gmail.read",
      }))
    )
      throw new Error("Attachment read authority changed.");
  };
  await current();
  const source = await createGmailReader(read).attachment(
    ownerId,
    {
      target: { ...target, operation: "gmail.read", calendarId: null },
      id: request.id,
      partId: request.partId,
    },
    signal,
  );
  const reader = source.stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let checkedAt = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      if (size - checkedAt >= 1_048_576) {
        await current();
        checkedAt = size;
      }
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > source.metadata.size || size > 25 * 1024 * 1024)
        throw new Error("Attachment exceeded its declared size.");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (size !== source.metadata.size) throw new Error("Attachment size changed.");
  const bytes = Buffer.concat(chunks);
  const metadata = artifactMetadataSchema.parse({
    name: artifactDisplayName(source.metadata.filename),
    mediaType: /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(source.metadata.mimeType)
      ? source.metadata.mimeType
      : "application/octet-stream",
    size,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    source: {
      kind: "connection",
      reference: source.metadata.reference,
      origin: {
        service: "gmail",
        connectionId: request.accountId,
        messageId: request.id,
        partId: request.partId,
        originalNameJson: JSON.stringify(source.metadata.filename),
        readActionId: actionId,
      },
    },
  });
  async function* authorizedBytes() {
    for (let offset = 0; offset < bytes.length; offset += 65_536) {
      signal.throwIfAborted();
      if (offset % 1_048_576 === 0) await current();
      yield bytes.subarray(offset, offset + 65_536);
    }
    await current();
  }
  await current();
  let artifact = await artifacts.upload(
    ownerId,
    `gmail-attachment:${actionId}`,
    metadata,
    authorizedBytes(),
    signal,
  );
  if (artifact && ["uploading", "verifying"].includes(artifact.state))
    artifact = await artifacts.reconcile(ownerId, artifact.id);
  await current();
  if (artifact?.state !== "ready")
    return {
      version: 1,
      status: "unknown",
      referenceId: actionId,
      message:
        "Attachment storage is not confirmed. Reuse this key to verify the existing artifact without fetching it again.",
    };
  return gmailAttachmentResult(artifact, request, actionId);
}
