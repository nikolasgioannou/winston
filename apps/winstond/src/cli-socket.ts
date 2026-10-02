/**
 * The CLI's door (docs/design.md §15): an HTTP server on a unix socket that
 * only local processes can reach. Each request is forwarded over the
 * websocket with the run token it carries, except the calls winstond answers
 * itself (`local`: the browser); nothing else is exposed.
 */
import { chmod, rm } from "node:fs/promises";
import { apiError, apiErrors } from "@winston/domain/api-errors";
import type { RpcMethod, RpcResponse } from "./daemon.ts";

const methods = new Set<string>(["GET", "POST", "PATCH", "PUT", "DELETE"]);

type Rpc = (request: {
  method: RpcMethod;
  path: string;
  body: string | null;
  runToken: string;
}) => Promise<RpcResponse>;

export async function serveCliSocket(
  socketPath: string,
  rpc: Rpc,
  local?: { handles: (path: string) => boolean; rpc: Rpc },
) {
  // A socket file left by a previous run would stop us binding.
  await rm(socketPath, { force: true });
  const server = Bun.serve({
    unix: socketPath,
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname + url.search;
      const reply = (status: number, body: string) =>
        new Response(body, {
          status,
          headers: { "Content-Type": "application/json" },
        });
      if (!methods.has(request.method) || !url.pathname.startsWith("/v1/"))
        return reply(
          apiErrors.not_found.status,
          JSON.stringify(
            apiError(
              "not_found",
              `There's no ${request.method} ${url.pathname}.`,
            ),
          ),
        );
      const runToken =
        request.headers.get("Authorization")?.match(/^Bearer (\S+)$/)?.[1] ??
        "";
      // An empty body counts as none.
      const text = request.method === "GET" ? "" : await request.text();
      const body = text === "" ? null : text;
      const call = {
        method: request.method as RpcMethod,
        path,
        body,
        runToken,
      };
      const response = local?.handles(url.pathname)
        ? await local.rpc(call)
        : await rpc(call);
      return reply(response.status, response.body);
    },
  });
  // The agent's commands run as winston; any local user may connect, and
  // every call still needs a valid run token for this VM's user.
  await chmod(socketPath, 0o666);
  return server;
}
