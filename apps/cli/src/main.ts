/**
 * `winston`: Winston's tools as a command line (docs/design.md §11). A thin
 * client: every call goes to winstond's unix socket.
 */
import { mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { apiClient, defaultSocketPath, localClient } from "./client.ts";
import { run } from "./cli.ts";

const socket = {
  socketPath: process.env.WINSTOND_SOCKET ?? defaultSocketPath,
  runToken: process.env.WINSTON_RUN_TOKEN,
};
const exitCode = await run(Bun.argv.slice(2), {
  out: (text) => {
    process.stdout.write(`${text}\n`);
  },
  err: (text) => {
    process.stderr.write(`${text}\n`);
  },
  text: {
    readStdin: () => Bun.stdin.text(),
    readFile: (path) => Bun.file(path).text(),
  },
  files: {
    home: process.env.HOME ?? "/home/winston",
    cwd: process.cwd(),
    exists: (path) => Bun.file(path).exists(),
    list: async (dir) => {
      const entries = await readdir(dir, {
        recursive: true,
        withFileTypes: true,
      }).catch(() => []);
      return entries
        .filter((entry) => entry.isFile())
        .map((entry) => relative(dir, join(entry.parentPath, entry.name)));
    },
    read: async (path) => new Uint8Array(await Bun.file(path).arrayBuffer()),
    write: async (path, bytes) => {
      await mkdir(dirname(path), { recursive: true });
      await Bun.write(path, bytes);
    },
    remove: (path) => rm(path, { force: true }),
  },
  client: () => apiClient(socket),
  local: () => localClient(socket),
});
process.exit(exitCode);
