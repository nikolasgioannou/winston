/**
 * `winston`: Winston's tools as a command line (docs/design.md §11). A thin
 * client: every call goes to winstond's unix socket.
 */
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
  },
  client: () => apiClient(socket),
  local: () => localClient(socket),
});
process.exit(exitCode);
