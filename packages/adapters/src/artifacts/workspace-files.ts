import { createHash } from "node:crypto";
import { filePublicationSchema, type FilePublication } from "@winston/contracts/artifacts";
import type { ServiceRequest } from "@winston/contracts/capabilities";
import type { CliResult } from "@winston/contracts/cli";
import type { createDatabase } from "../database";
import type { createArtifactService } from "./index";

export function createWorkspaceFilePublisher(options: {
  database: ReturnType<typeof createDatabase>;
  artifacts: Pick<ReturnType<typeof createArtifactService>, "upload" | "reconcile">;
}) {
  return async (
    credential: ServiceRequest,
    input: FilePublication,
    source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
    signal: AbortSignal,
  ): Promise<CliResult> => {
    const request = filePublicationSchema.parse(input);
    const authority = await options.database.authenticateService(credential);
    if (authority?.operation !== "gateway:control")
      return {
        version: 1,
        status: "denied",
        message: "File publication authority is unavailable or expired.",
      };
    const initial = await options.database.transaction(authority.ownerId, ({ filePublications }) =>
      filePublications.authorize(credential, request),
    );
    if (initial.status !== "allowed")
      return {
        version: 1,
        status: initial.status,
        message: "File publication is not permitted by the current workspace policy.",
      };
    const current = async () => {
      signal.throwIfAborted();
      const checked = await options.database.transaction(
        authority.ownerId,
        ({ filePublications }) => filePublications.authorize(credential, request, initial.snapshot),
      );
      return checked.status === "allowed" && checked.key === initial.key;
    };
    async function* checkedBytes() {
      const hash = createHash("sha256");
      let size = 0;
      let checkedAt = 0;
      if (!(await current())) throw new Error("File publication authority changed.");
      for await (const chunk of source) {
        signal.throwIfAborted();
        size += chunk.byteLength;
        if (size > request.size) throw new Error("File exceeds its declared size.");
        if (size - checkedAt >= 1_048_576) {
          if (!(await current())) throw new Error("File publication authority changed.");
          checkedAt = size;
        }
        hash.update(chunk);
        yield chunk;
      }
      if (size !== request.size || hash.digest("hex") !== request.sha256 || !(await current()))
        throw new Error("File content or authority changed.");
    }
    try {
      let artifact = await options.artifacts.upload(
        authority.ownerId,
        initial.key,
        initial.metadata,
        checkedBytes(),
        signal,
      );
      if (artifact && ["uploading", "verifying"].includes(artifact.state))
        artifact = await options.artifacts.reconcile(authority.ownerId, artifact.id);
      if (!(await current()))
        return {
          version: 1,
          status: "denied",
          message: "File publication authority changed before completion.",
        };
      if (artifact?.state !== "ready")
        return {
          version: 1,
          status: artifact?.state === "failed" ? "unavailable" : "unknown",
          message: "The file has not been confirmed ready for delivery.",
        };
      return { version: 1, status: "ok", data: { artifactId: artifact.id, ...artifact.metadata } };
    } catch {
      return {
        version: 1,
        status: "unknown",
        message: "Publication was not confirmed. Reuse the same key and file to check its result.",
      };
    }
  };
}
