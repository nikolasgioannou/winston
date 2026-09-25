import { createHash } from "node:crypto";
import {
  filePublicationSchema,
  type FilePublication,
  type Artifact,
} from "@winston/contracts/artifacts";
import type { ServiceRequest } from "@winston/contracts/capabilities";
import type { CliResult } from "@winston/contracts/cli";
import type { createDatabase } from "../database";
import type { createArtifactService } from "./index";
import { canonicalJson } from "@winston/contracts/json";
import { prepareWorkspaceFilePublication } from "./workspace-file-actions";

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
    const preflight = await options.database.transaction(
      authority.ownerId,
      ({ filePublications }) => filePublications.authorize(credential, request),
    );
    if (preflight.status === "denied")
      return {
        version: 1,
        status: "denied",
        message: "File publication is not permitted by the current workspace policy.",
      };
    let prepared;
    try {
      prepared = await prepareWorkspaceFilePublication(
        options.database,
        authority.ownerId,
        credential,
        request,
      );
    } catch {
      return {
        version: 1,
        status: "unavailable",
        message: "This publication key conflicts with its file or is no longer available.",
      };
    }
    if (prepared.kind === "result") return prepared.result;
    const proof = {
      id: prepared.action.id,
      ...(prepared.kind === "dispatch" ? { token: prepared.token } : {}),
    };
    const initial = await options.database.transaction(authority.ownerId, ({ filePublications }) =>
      filePublications.authorize(credential, request, undefined, proof),
    );
    if (initial.status !== "allowed") {
      if (prepared.kind === "dispatch")
        await options.database.transaction(authority.ownerId, ({ actions }) =>
          actions.report(prepared.action.id, prepared.token, {
            state: "failed",
            detail: "File publication authority changed before upload.",
            providerReference: null,
          }),
        );
      return { version: 1, status: "denied", message: "File publication authority changed." };
    }
    const current = async (receipt = false) => {
      signal.throwIfAborted();
      const checked = await options.database.transaction(
        authority.ownerId,
        ({ filePublications }) =>
          filePublications.authorize(
            credential,
            request,
            initial.snapshot,
            receipt ? { id: proof.id } : proof,
          ),
      );
      return checked.status === "allowed" && checked.key === initial.key;
    };
    const result = (artifact: Artifact): CliResult => ({
      version: 1,
      status: "ok",
      data: { artifactId: artifact.id, revision: artifact.revision, ...artifact.metadata },
    });
    if (prepared.kind === "receipt") {
      try {
        let artifact = await options.database.transaction(authority.ownerId, ({ artifacts }) =>
          artifacts.findByKey(initial.key),
        );
        if (!artifact || canonicalJson(artifact.metadata) !== canonicalJson(initial.metadata))
          return {
            version: 1,
            status: "unknown",
            referenceId: proof.id,
            message: "The published file has no confirmed matching artifact.",
          };
        if (["uploading", "verifying"].includes(artifact.state))
          artifact = await options.artifacts.reconcile(authority.ownerId, artifact.id);
        if (!(await current()))
          return { version: 1, status: "denied", message: "File publication authority changed." };
        if (artifact?.state !== "ready")
          return {
            version: 1,
            status: "unknown",
            referenceId: proof.id,
            message: "The existing upload is not confirmed ready. It was not uploaded again.",
          };
        if (prepared.action.state === "unknown") {
          const saved = await options.database.transaction(authority.ownerId, ({ actions }) =>
            actions.reconcile(proof.id, prepared.action.operationId, {
              state: "succeeded",
              detail: "The exact published artifact was verified.",
              providerReference: artifact.id,
            }),
          );
          if (!saved) throw new Error("Publication receipt changed.");
        }
        if (!(await current()))
          return { version: 1, status: "denied", message: "File publication authority changed." };
        return result(artifact);
      } catch {
        return {
          version: 1,
          status: "unknown",
          referenceId: proof.id,
          message: "Publication verification is unavailable. No upload was repeated.",
        };
      }
    }
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
      const state =
        artifact?.state === "ready"
          ? "succeeded"
          : artifact?.state === "failed"
            ? "failed"
            : "unknown";
      await options.database.transaction(authority.ownerId, ({ actions }) =>
        actions.report(proof.id, prepared.token, {
          state,
          detail:
            state === "succeeded"
              ? "The exact file was published."
              : "File publication did not produce a confirmed ready artifact.",
          providerReference: artifact?.id ?? null,
        }),
      );
      const finalAuthorization = await options.database.transaction(
        authority.ownerId,
        ({ filePublications }) =>
          filePublications.authorize(
            credential,
            request,
            initial.snapshot,
            state === "failed" ? undefined : { id: proof.id },
          ),
      );
      if (
        finalAuthorization.status === "denied" ||
        (state !== "failed" && finalAuthorization.status !== "allowed")
      )
        return {
          version: 1,
          status: "denied",
          message: "File publication authority changed before completion.",
        };
      if (artifact?.state !== "ready")
        return {
          version: 1,
          status: artifact?.state === "failed" ? "unavailable" : "unknown",
          referenceId: proof.id,
          message: "The file has not been confirmed ready for delivery.",
        };
      return result(artifact);
    } catch {
      await options.database.transaction(authority.ownerId, ({ actions }) =>
        actions.report(proof.id, prepared.token, {
          state: "unknown",
          detail: "File publication ended without a confirmed receipt.",
          providerReference: null,
        }),
      );
      return {
        version: 1,
        status: "unknown",
        referenceId: proof.id,
        message: "Publication was not confirmed. Reuse the same key and file to check its result.",
      };
    }
  };
}
