import type { createDatabase } from "@winston/adapters/database";
import type { createArtifactReader } from "@winston/adapters/artifacts";
import { createVoiceTranscriber, transcribeNextVoice } from "@winston/adapters/models";
import { startOwnerFileLoop } from "./owner-loop";

export function startVoiceRuntime(options: {
  database: ReturnType<typeof createDatabase>;
  botId: number;
  apiKey: string;
  read: ReturnType<typeof createArtifactReader>;
  notice: (code: string) => void;
}) {
  const transcribe = createVoiceTranscriber(options.apiKey);
  return startOwnerFileLoop({
    ...options,
    run: (ownerId, signal) =>
      transcribeNextVoice(
        options.database,
        ownerId,
        options.botId,
        options.read,
        transcribe,
        signal,
      ),
    failed: () => {
      options.notice("voice-transcription-failed");
    },
  });
}
