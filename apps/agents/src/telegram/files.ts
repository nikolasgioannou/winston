import { GrammyError, type Api } from "grammy";

/** The Bot API's download limit for bots (docs/design.md §4, Media). */
export const maxDownloadBytes = 20 * 1024 * 1024;

/** Downloads files users sent, by Telegram file id. */
export interface TelegramFiles {
  /** The file's bytes, or `too_large` past the Bot API's 20 MB limit. */
  download(fileId: string): Promise<Uint8Array | "too_large">;
}

/**
 * Downloads through the Bot API: `getFile` for a path, then the file URL,
 * which stays valid for at least an hour. Files over 20 MB fail `getFile`
 * with "file is too big" (not in the docs; widely reported).
 */
export function botApiFiles(
  api: Api,
  token: string,
  timeoutMs = 60_000,
): TelegramFiles {
  return {
    async download(fileId) {
      let path: string | undefined;
      try {
        ({ file_path: path } = await api.getFile(fileId));
      } catch (error) {
        if (
          error instanceof GrammyError &&
          /file is too big/i.test(error.description)
        )
          return "too_large";
        throw error;
      }
      if (!path) throw new Error("getFile returned no file path");
      const response = await fetch(
        `https://api.telegram.org/file/bot${token}/${path}`,
        { signal: AbortSignal.timeout(timeoutMs) },
      );
      if (!response.ok)
        throw new Error(
          `Telegram file download failed with ${String(response.status)}`,
        );
      const bytes = new Uint8Array(await response.arrayBuffer());
      return bytes.length > maxDownloadBytes ? "too_large" : bytes;
    },
  };
}
