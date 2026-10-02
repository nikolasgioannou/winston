import { apiClient, localClient } from "./client.ts";
import { run } from "./cli.ts";

/** Runs the CLI against a fake backend; returns the exit code, output and requests. */
export async function cli(
  argv: string[],
  backend: (request: Request) => Response | Promise<Response>,
  existing: string[] = [],
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
      exists: (path) => Promise.resolve(existing.includes(path)),
    },
    client: () => apiClient(socket),
    local: () => localClient(socket),
  });
  return { code, out: out.join("\n"), err: err.join("\n"), requests };
}
