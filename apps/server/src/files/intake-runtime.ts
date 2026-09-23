import type { createDatabase } from "@winston/adapters/database";
import type { createArtifactService } from "@winston/adapters/artifacts";
import { createTelegramDownloader, intakeTelegramFile } from "@winston/adapters/telegram";
import { startOwnerFileLoop } from "./runtime";

export function startFileIntakeRuntime(options: {
  database: ReturnType<typeof createDatabase>;
  botId: number;
  token: string;
  artifacts: ReturnType<typeof createArtifactService>;
  notice: (code: string) => void;
}) {
  const download = createTelegramDownloader(options.token);
  return startOwnerFileLoop({
    ...options,
    run: (ownerId, signal) =>
      intakeTelegramFile(
        options.database,
        ownerId,
        options.botId,
        download,
        options.artifacts,
        signal,
      ),
    failed: () => {
      options.notice("telegram-file-intake-failed");
    },
  });
}
