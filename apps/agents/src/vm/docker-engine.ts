/**
 * A minimal Docker Engine API client over its unix socket, using Bun's
 * `fetch` with `unix`. The API gives structured results, which shelling out
 * to `docker` wouldn't.
 */

/** The Engine API version we speak (Docker 25+), so responses keep their shape. */
const apiVersion = "v1.44";

export interface DockerEngine {
  /** The parsed JSON body, typed by the caller for the endpoint it called. */
  request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }>;
}

export class DockerApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    message: string,
  ) {
    super(`Docker ${path} failed (${String(status)}): ${message}`);
  }
}

export function dockerEngine(socketPath: string): DockerEngine {
  return {
    async request(
      method: "GET" | "POST" | "DELETE",
      path: string,
      body?: unknown,
    ) {
      const response = await fetch(`http://docker/${apiVersion}${path}`, {
        method,
        unix: socketPath,
        headers:
          body === undefined ? {} : { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      return {
        status: response.status,
        body: (text ? JSON.parse(text) : undefined) as unknown,
      };
    },
  };
}

/**
 * The Docker socket: from `DOCKER_HOST` if it's a unix socket, otherwise the
 * active Docker context (Colima, OrbStack and Docker Desktop each use their
 * own socket path).
 */
export async function dockerSocketPath(env = process.env) {
  const host = env.DOCKER_HOST;
  if (host?.startsWith("unix://")) return host.slice("unix://".length);
  const proc = Bun.spawn(
    ["docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const output = (await new Response(proc.stdout).text()).trim();
  if ((await proc.exited) !== 0 || !output.startsWith("unix://"))
    throw new Error(
      "Can't find the Docker socket. Is Docker running? (./scripts/setup.sh checks.)",
    );
  return output.slice("unix://".length);
}
