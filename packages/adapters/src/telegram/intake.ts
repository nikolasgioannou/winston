import type { OwnerTransaction } from "../database";
import type { createArtifactService } from "../artifacts";
import { TelegramDownloadError, type createTelegramDownloader } from "./download";

export async function intakeTelegramFile(
  database: {
    transaction<Result>(
      ownerId: string,
      work: (scope: Pick<OwnerTransaction, "telegramIntake" | "artifacts">) => Promise<Result>,
    ): Promise<Result>;
  },
  ownerId: string,
  botId: number,
  download: ReturnType<typeof createTelegramDownloader>,
  artifacts: Pick<ReturnType<typeof createArtifactService>, "resumeUpload">,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const intake = await database.transaction(ownerId, async ({ telegramIntake }) => {
    await telegramIntake.discover(botId);
    return telegramIntake.claim(botId);
  });
  if (!intake) return "idle";
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
  try {
    const file = await download(
      intake.fileId,
      deadline,
      intake.expectedSize === null ? undefined : Number(intake.expectedSize),
    );
    deadline.throwIfAborted();
    const prepared = await database.transaction(ownerId, async (scope) => {
      if (!(await scope.telegramIntake.active(intake))) return null;
      // Preserve the original name in the message; catalog names cannot contain paths or controls.
      const name = intake.filename.slice(0, 200).replace(/[\p{Cc}\p{Cs}/\\]/gu, "_");
      return scope.artifacts.prepare(`telegram:${intake.id}`, {
        name: name || "attachment",
        mediaType: intake.mediaType,
        size: file.size,
        sha256: file.sha256,
        source: {
          kind: "telegram",
          reference: `message:${intake.messageId}/attachment:${intake.id}`,
        },
      });
    });
    if (!prepared) return "canceled";
    const artifact = await artifacts.resumeUpload(
      ownerId,
      prepared.artifact.id,
      [file.bytes],
      deadline,
    );
    if (artifact?.state === "ready") {
      const stored = await database.transaction(ownerId, ({ telegramIntake }) =>
        telegramIntake.stored(intake, artifact.id),
      );
      // Another lease can reuse this immutable artifact. Never delete it on a stale completion.
      return stored ? "stored" : "canceled";
    }
  } catch (error) {
    if (error instanceof TelegramDownloadError && error.code === "too_large") {
      const failed = await database.transaction(ownerId, ({ telegramIntake }) =>
        telegramIntake.fail(intake, "too_large"),
      );
      return failed ? "too-large" : "canceled";
    }
    // Provider errors can contain credentials. Only the bounded retry state escapes.
  }
  const retried = await database.transaction(ownerId, ({ telegramIntake }) =>
    telegramIntake.retry(intake),
  );
  return retried ? "retry" : "canceled";
}
