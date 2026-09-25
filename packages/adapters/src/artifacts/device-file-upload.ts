import { createHash } from "node:crypto";
import {
  deviceFileUploadSchema,
  type DeviceFileUpload,
  type DeviceFileUploadResult,
} from "@winston/contracts/artifacts";
import { canonicalJson } from "@winston/contracts/json";
import type { OwnerTransaction } from "../database";
import type { createArtifactService } from "./index";
import { deviceFileMetadata } from "./device-file-metadata";

type Database = {
  transaction<Result>(
    ownerId: string,
    work: (scope: Pick<OwnerTransaction, "actions" | "artifacts">) => Promise<Result>,
  ): Promise<Result>;
};

export function createDeviceFileReceiver(options: {
  database: Database;
  artifacts: Pick<ReturnType<typeof createArtifactService>, "resumeUpload" | "reconcile">;
}) {
  return async (
    ownerId: string,
    authenticatedDeviceId: string,
    input: DeviceFileUpload,
    source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
    signal: AbortSignal,
  ): Promise<DeviceFileUploadResult> => {
    const request = deviceFileUploadSchema.parse(input);
    const result = (status: "unknown" | "denied" | "conflict" | "invalid_file") => ({
      version: 1 as const,
      status,
      transferId: request.authority.transferId,
    });
    signal.throwIfAborted();
    const prepared = await options.database.transaction(ownerId, async ({ actions, artifacts }) => {
      const execution = await actions.authorizeDeviceFileTransfer(
        authenticatedDeviceId,
        request.authority,
      );
      if (!execution) return { status: "denied" as const };
      const metadata = deviceFileMetadata(execution, request);
      const key = `device-file:${execution.actionId}`;
      const existing = await artifacts.findByKey(key);
      if (existing && canonicalJson(existing.metadata) !== canonicalJson(metadata))
        return { status: "conflict" as const };
      if (existing && ["deleting", "deleted", "failed"].includes(existing.state))
        return { status: "denied" as const };
      const artifact = existing ?? (await artifacts.prepare(key, metadata)).artifact;
      return { status: "prepared" as const, actionId: execution.actionId, artifact };
    });
    if (prepared.status !== "prepared") return result(prepared.status);
    const progress = { authorityLost: false, invalidBytes: false };
    const current = async () => {
      signal.throwIfAborted();
      const checked = await options.database.transaction(ownerId, ({ actions }) =>
        actions.authorizeDeviceFileTransfer(authenticatedDeviceId, request.authority),
      );
      if (!checked || checked.actionId !== prepared.actionId) {
        progress.authorityLost = true;
        throw new Error("Native file authority changed.");
      }
    };
    async function* checkedBytes() {
      await current();
      let count = 0;
      let checkedAt = 0;
      const hash = createHash("sha256");
      for await (const chunk of source) {
        signal.throwIfAborted();
        if (!(chunk instanceof Uint8Array) || count + chunk.byteLength > request.size) {
          progress.invalidBytes = true;
          throw new Error("Invalid native file bytes.");
        }
        for (let offset = 0; offset < chunk.byteLength; offset += 65_536) {
          signal.throwIfAborted();
          if (count - checkedAt >= 1_048_576) {
            await current();
            checkedAt = count;
          }
          const part = chunk.subarray(offset, offset + 65_536);
          count += part.byteLength;
          hash.update(part);
          yield part;
        }
      }
      if (count !== request.size || hash.digest("hex") !== request.sha256) {
        progress.invalidBytes = true;
        throw new Error("Native file checksum or size differs.");
      }
      await current();
    }
    try {
      // Reserve immutable identity before I/O. The existing resume path conditionally uploads
      // only when storage confirms this object is absent; uncertain completion is reconciled.
      let artifact = await options.artifacts.resumeUpload(
        ownerId,
        prepared.artifact.id,
        checkedBytes(),
        signal,
      );
      await current();
      if (progress.invalidBytes) return result("invalid_file");
      if (artifact && ["uploading", "verifying"].includes(artifact.state))
        artifact = await options.artifacts.reconcile(ownerId, artifact.id);
      await current();
      if (artifact && ["deleting", "deleted"].includes(artifact.state)) return result("denied");
      if (artifact?.state !== "ready") return result("unknown");
      return {
        version: 1,
        status: "ready",
        transferId: request.authority.transferId,
        artifactId: artifact.id,
        revision: artifact.revision,
        size: artifact.metadata.size,
        sha256: artifact.metadata.sha256,
      };
    } catch {
      return result(
        progress.authorityLost ? "denied" : progress.invalidBytes ? "invalid_file" : "unknown",
      );
    }
  };
}
