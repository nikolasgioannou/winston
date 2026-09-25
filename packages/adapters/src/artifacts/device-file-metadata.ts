import { deviceFileArtifactSchema, type DeviceFileUpload } from "@winston/contracts/artifacts";
import type { DeviceExecution } from "@winston/contracts/device-executions";
import { artifactDisplayName } from "./display-name";

export function deviceFileMetadata(execution: DeviceExecution, request: DeviceFileUpload) {
  const payload = execution.message.payload;
  if (payload.kind !== "execute" || payload.operation.kind !== "file.read")
    throw new Error("Expected an authorized native file read.");
  return deviceFileArtifactSchema.shape.metadata.parse({
    name: artifactDisplayName(payload.operation.path.split("/").at(-1) ?? "", "file"),
    mediaType: "application/octet-stream",
    size: request.size,
    sha256: request.sha256,
    source: {
      kind: "device",
      reference: `device:${execution.message.deviceId}:${payload.executionId}`,
      origin: {
        deviceId: execution.message.deviceId,
        path: payload.operation.path,
        executionId: payload.executionId,
        transferId: payload.operation.transferId,
        readActionId: execution.actionId,
      },
    },
  });
}
