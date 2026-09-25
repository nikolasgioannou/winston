import { createHash } from "node:crypto";
import { gmailAttachmentArtifactSchema } from "@winston/contracts/artifacts";
import { cliResultSchema, type CliReadRequest } from "@winston/contracts/cli";

export function readGmailAttachmentArtifact(
  input: unknown,
  request: Extract<CliReadRequest, { command: "gmail.attachment" }>,
  actionId: string,
) {
  const artifact = gmailAttachmentArtifactSchema.parse(input);
  const origin = artifact.metadata.source.origin;
  const expected = createHash("sha256")
    .update(JSON.stringify([request.accountId, request.id, request.partId]))
    .digest("hex");
  if (
    origin.connectionId !== request.accountId ||
    origin.messageId !== request.id ||
    origin.partId !== request.partId ||
    origin.readActionId !== actionId ||
    artifact.metadata.source.reference !== expected
  )
    throw new Error("Attachment artifact does not match the authorized source.");
  return artifact;
}

export function gmailAttachmentResult(
  input: unknown,
  request: Extract<CliReadRequest, { command: "gmail.attachment" }>,
  actionId: string,
) {
  const artifact = readGmailAttachmentArtifact(input, request, actionId);
  if (artifact.state !== "ready") throw new Error("Attachment artifact is not ready.");
  return cliResultSchema.parse({
    version: 1,
    status: "ok",
    data: { artifactId: artifact.id, ...artifact.metadata, trust: "untrusted_external_content" },
  });
}
