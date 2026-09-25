import type { createDatabase } from "@winston/adapters/database";
import type { ServiceRequest } from "@winston/contracts/capabilities";
import type { CliRequest, CliResult } from "@winston/contracts/cli";

export type FileRequest = Extract<CliRequest, { command: "files.send" | "files.status" }>;
export function createFileCommands(database: ReturnType<typeof createDatabase>, botId: number) {
  return async (credential: ServiceRequest, request: FileRequest): Promise<CliResult> => {
    const authority = await database.authenticateService(credential);
    if (!authority) return { version: 1, status: "denied", message: "Task authority unavailable." };
    try {
      return await database.transaction(
        authority.ownerId,
        async ({ capabilities, telegramFiles }) => {
          const current = await capabilities.authenticate(credential);
          if (
            !current ||
            (request.command === "files.send" && current.operation !== "gateway:control")
          )
            return { version: 1, status: "denied", message: "Task authority unavailable." };
          let delivery;
          if (request.command === "files.send") {
            const prepared = await telegramFiles.prepare({
              key: request.key,
              artifactId: request.id,
              botId,
              workspaceId: current.resourceId,
              task: {
                id: current.taskId,
                revision: current.revision,
                generation: current.generation,
              },
            });
            if (prepared.kind === "denied")
              return {
                version: 1,
                status: "denied",
                message: "This exact file delivery is not permitted or is no longer available.",
              };
            if (prepared.kind === "waiting" || prepared.kind === "unknown")
              return {
                version: 1,
                status: prepared.kind,
                referenceId: prepared.actionId,
                message:
                  prepared.kind === "waiting"
                    ? "Waiting for exact file-read approval. Resume files send with the same artifact and key."
                    : "File-read approval could not be confirmed. Reuse the same artifact and key.",
              };
            delivery = prepared.delivery;
          } else delivery = await telegramFiles.find(request.id);
          if (!delivery || delivery.taskId !== current.taskId)
            return {
              version: 1,
              status: "unavailable",
              message: "File delivery unavailable to this task.",
            };
          return {
            version: 1,
            status: "ok",
            data: {
              deliveryId: delivery.id,
              artifactId: delivery.artifactId,
              state: delivery.state,
              messageId: delivery.messageId,
            },
          };
        },
      );
    } catch {
      return {
        version: 1,
        status: "unknown",
        message:
          "Delivery could not be confirmed. Reuse the same key and artifact to recover; do not assume it was sent.",
      };
    }
  };
}
