import { apiClient, localClient } from "./client.ts";
import { run } from "./cli.ts";

/**
 * Runs the CLI against a fake backend; returns the exit code, output and
 * requests. `disk` is the VM's files, by absolute path; what the CLI writes
 * and removes shows up in it.
 */
export async function cli(
  argv: string[],
  backend: (request: Request) => Response | Promise<Response>,
  existing: string[] = [],
  disk = new Map<string, Uint8Array>(),
) {
  const out: string[] = [];
  const err: string[] = [];
  const requests: Request[] = [];
  const socket = {
    socketPath: "/unused",
    runToken: "run-token",
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(
        input instanceof Request ? input.url : String(input),
        init,
      );
      requests.push(request);
      return backend(new Request(request));
    },
  };
  const code = await run(argv, {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    text: {
      readStdin: () => Promise.resolve("Tuesday works.\nThanks, Dana."),
      readFile: (path) => Promise.resolve(`contents of ${path}`),
    },
    files: {
      home: "/home/winston",
      cwd: "/home/winston/notes",
      exists: (path) =>
        Promise.resolve(existing.includes(path) || disk.has(path)),
      list: (dir) =>
        Promise.resolve(
          [...disk.keys()]
            .filter((path) => path.startsWith(`${dir}/`))
            .map((path) => path.slice(dir.length + 1)),
        ),
      read: (path) => {
        const bytes = disk.get(path);
        return bytes
          ? Promise.resolve(bytes)
          : Promise.reject(new Error(`no file ${path}`));
      },
      write: (path, bytes) => {
        disk.set(path, bytes);
        return Promise.resolve();
      },
      remove: (path) => {
        disk.delete(path);
        return Promise.resolve();
      },
    },
    client: () => apiClient(socket),
    local: () => localClient(socket),
  });
  return { code, out: out.join("\n"), err: err.join("\n"), requests };
}
