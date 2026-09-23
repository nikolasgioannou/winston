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
          const delivery =
            request.command === "files.send"
              ? await telegramFiles.enqueue({
                  key: request.key,
                  artifactId: request.id,
                  botId,
                  workspaceId: current.resourceId,
                  task: {
                    id: current.taskId,
                    revision: current.revision,
                    generation: current.generation,
                  },
                })
              : await telegramFiles.find(request.id);
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
