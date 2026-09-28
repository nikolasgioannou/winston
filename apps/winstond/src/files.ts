/**
 * How winstond reaches files: as `winston`, by running its own binary in a
 * helper mode through sudo (the same rule as exec; docs/design.md §15).
 * The helper does the confined operation and streams bytes on stdout or
 * takes them on stdin.
 */
import type { FileErrorCode } from "@winston/domain/frames";
import { asWinston } from "./exec.ts";
import { FileOpError, openForRead, writeAtomically } from "./file-ops.ts";

export class FileTransferError extends Error {
  constructor(
    readonly code: FileErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface Files {
  read(path: string): Promise<AsyncIterable<Uint8Array>>;
  write(
    path: string,
    expected: { size: number; sha256: string },
    source: AsyncIterable<Uint8Array>,
  ): Promise<void>;
}

const toTransferError = (error: unknown) =>
  error instanceof FileOpError
    ? new FileTransferError(error.code, error.message)
    : new FileTransferError(
        "failed",
        error instanceof Error ? error.message : String(error),
      );

/** In-process file access under `root`, without switching users (tests, and the helper itself). */
export function localFiles(root: string): Files {
  return {
    async read(path) {
      try {
        return (await openForRead(root, path)).stream;
      } catch (error) {
        throw toTransferError(error);
      }
    },
    async write(path, expected, source) {
      try {
        await writeAtomically(root, path, expected, source);
      } catch (error) {
        throw toTransferError(error);
      }
    },
  };
}

/** Reads the helper's failure report from stderr. */
async function helperError(stderr: ReadableStream<Uint8Array>) {
  const text = await new Response(stderr).text();
  try {
    const { code, message } = JSON.parse(text) as {
      code: FileErrorCode;
      message: string;
    };
    return new FileTransferError(code, message);
  } catch {
    return new FileTransferError(
      "failed",
      text.trim() || "the file helper failed",
    );
  }
}

/** File access as `winston`, through winstond's helper mode. */
export function helperFiles(
  helper: string[] = [...asWinston, process.execPath],
): Files {
  return {
    async read(path) {
      const proc = Bun.spawn([...helper, "file-read", path], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const reader = proc.stdout.getReader();
      // The first read tells a failed open from a file that's streaming.
      const first = await reader.read();
      if (first.done && (await proc.exited) !== 0)
        throw await helperError(proc.stderr);
      return (async function* () {
        if (!first.done) yield first.value;
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          yield next.value;
        }
        if ((await proc.exited) !== 0) throw await helperError(proc.stderr);
      })();
    },
    async write(path, expected, source) {
      const proc = Bun.spawn(
        [...helper, "file-write", path, String(expected.size), expected.sha256],
        { stdin: "pipe", stdout: "ignore", stderr: "pipe" },
      );
      for await (const chunk of source) {
        void proc.stdin.write(chunk);
        await proc.stdin.flush();
      }
      await proc.stdin.end();
      if ((await proc.exited) !== 0) throw await helperError(proc.stderr);
    },
  };
}

/** The helper mode: `winstond file-read <path>` / `winstond file-write <path> <size> <sha256>`. */
export async function runFileHelper(args: string[], root = "/home/winston") {
  const files = localFiles(root);
  try {
    const [command, path, size, sha256] = args;
    if (command === "file-read" && path) {
      const out = Bun.stdout.writer();
      for await (const chunk of await files.read(path)) {
        void out.write(chunk);
        await out.flush();
      }
      await out.end();
    } else if (command === "file-write" && path && size && sha256) {
      await files.write(
        path,
        { size: Number(size), sha256 },
        Bun.stdin.stream(),
      );
    } else
      throw new FileTransferError(
        "failed",
        "usage: file-read <path> | file-write <path> <size> <sha256>",
      );
    return 0;
  } catch (error) {
    const failure =
      error instanceof FileTransferError
        ? error
        : new FileTransferError("failed", String(error));
    process.stderr.write(
      JSON.stringify({ code: failure.code, message: failure.message }),
    );
    return 2;
  }
}
