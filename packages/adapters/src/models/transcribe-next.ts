import type { OwnerTransaction } from "../database";
import type { createArtifactReader } from "../artifacts";
import { TranscriptionError, type createVoiceTranscriber } from "./transcription";

export async function transcribeNextVoice(
  database: {
    transaction<Result>(
      ownerId: string,
      work: (scope: Pick<OwnerTransaction, "voice">) => Promise<Result>,
    ): Promise<Result>;
  },
  ownerId: string,
  botId: number,
  read: ReturnType<typeof createArtifactReader>,
  transcribe: ReturnType<typeof createVoiceTranscriber>,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const lease = await database.transaction(ownerId, ({ voice }) => voice.claim(botId));
  if (!lease) return "idle";
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(150_000)]);
  try {
    const file = await read(ownerId, lease.artifactId, 20_000_000, deadline);
    if (!file) {
      await database.transaction(ownerId, ({ voice }) => voice.fail(lease));
      return "failed";
    }
    if (!(await database.transaction(ownerId, ({ voice }) => voice.active(lease))))
      return "canceled";
    const result = await transcribe(file.bytes, deadline);
    deadline.throwIfAborted();
    return await database.transaction(ownerId, async ({ voice }) =>
      (await voice.complete(lease, result)) ? "completed" : "canceled",
    );
  } catch (error) {
    if (error instanceof TranscriptionError && error.code === "invalid_audio") {
      await database.transaction(ownerId, ({ voice }) => voice.fail(lease));
      return "failed";
    }
    const retried = await database.transaction(ownerId, ({ voice }) => voice.retry(lease));
    return retried ? "retry" : "canceled";
  }
}
