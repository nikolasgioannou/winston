import type { createDatabase } from "@winston/adapters/database";
import {
  stageInboxFile,
  type createArtifactReader,
  type createArtifactService,
} from "@winston/adapters/artifacts";
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

export function startInboxStagingRuntime(options: {
  database: ReturnType<typeof createDatabase>;
  botId: number;
  read: ReturnType<typeof createArtifactReader>;
  notice: (code: string) => void;
}) {
  return startOwnerFileLoop({
    ...options,
    run: (ownerId, signal) =>
      stageInboxFile(options.database, ownerId, options.botId, options.read, signal),
    failed: () => {
      options.notice("inbox-staging-failed");
    },
  });
}
