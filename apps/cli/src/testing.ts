import { apiClient } from "./client.ts";
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
    client: () =>
      apiClient({
        socketPath: "/unused",
        runToken: "run-token",
        fetch: async (input, init) => {
          const request = new Request(
            input instanceof Request ? input.url : String(input),
            init,
          );
          requests.push(request);
          return backend(new Request(request));
        },
      }),
  });
  return { code, out: out.join("\n"), err: err.join("\n"), requests };
}
