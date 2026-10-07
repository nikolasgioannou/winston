/**
 * A small MCP client over Streamable HTTP (93ff50, docs/design.md §5), for
 * connected apps reached through a remote MCP server (Ramp). It only calls
 * tools, by name: nothing reaches a tool its caller didn't name. Written by
 * hand rather than with the official SDK, which brings a server stack
 * (Express, CORS) the gateway doesn't need for a few JSON-RPC calls.
 */
import { ProviderRefusedError, ProviderUnavailableError } from "./errors.ts";

/** The protocol version Winston speaks (Ramp's too, 2026-10-07). */
export const mcpProtocolVersion = "2025-06-18";

/**
 * An access token for the server. `rejected` is one the server just refused,
 * so a copy of it mustn't come back; the token's owner throws
 * `ConnectionUnavailableError` if the grant is gone.
 */
export type McpAccessToken = (rejected?: string) => Promise<string>;

export interface McpClient {
  /** Calls a tool and returns its text, or throws `ProviderRefusedError` for a tool error. */
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
}

interface JsonRpcMessage {
  id?: number;
  result?: {
    content?: { type: string; text?: string }[];
    isError?: boolean;
  };
  error?: { code: number; message: string };
}

/** The message answering `id`, from a JSON body or a stream of server-sent events. */
function answerTo(id: number, text: string, contentType: string) {
  if (!contentType.includes("text/event-stream"))
    return JSON.parse(text) as JsonRpcMessage;
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    const message = JSON.parse(data) as JsonRpcMessage;
    if (message.id === id) return message;
  }
  throw new ProviderUnavailableError(
    "The server's stream ended without an answer.",
  );
}

/** The server forgot the session (the spec's 404), so a new one is needed. */
class SessionGoneError extends Error {}

export function mcpClient({
  url,
  accessToken,
  fetch: send = fetch,
  timeoutMs = 30_000,
}: {
  url: string;
  accessToken: McpAccessToken;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): McpClient {
  let session: string | undefined;
  let lastId = 0;

  /** One POST, retried once with a fresh token if the server refuses the token. */
  async function post(body: object) {
    let token = await accessToken();
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await send(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": mcpProtocolVersion,
            ...(session ? { "mcp-session-id": session } : {}),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new ProviderUnavailableError(
          `The server didn't answer: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (response.status !== 401 || attempt > 0) return response;
      token = await accessToken(token);
    }
  }

  async function request(method: string, params: object) {
    const id = ++lastId;
    const response = await post({ jsonrpc: "2.0", id, method, params });
    const text = await response.text();
    if (response.status === 404 && session) throw new SessionGoneError();
    if (response.status === 429 || response.status >= 500)
      throw new ProviderUnavailableError(
        `The server answered ${String(response.status)}.`,
      );
    if (!response.ok)
      throw new ProviderRefusedError(
        `The server refused ${method} (${String(response.status)}): ${text.slice(0, 300)}`,
      );
    session = response.headers.get("mcp-session-id") ?? session;
    return answerTo(id, text, response.headers.get("content-type") ?? "");
  }

  async function initialize() {
    session = undefined;
    const started = await request("initialize", {
      protocolVersion: mcpProtocolVersion,
      capabilities: {},
      clientInfo: { name: "winston", version: "1" },
    });
    if (started.error)
      throw new ProviderUnavailableError(
        `The server wouldn't start a session: ${started.error.message}`,
      );
    await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  async function call(name: string, args: Record<string, unknown>) {
    if (session === undefined) await initialize();
    return request("tools/call", { name, arguments: args });
  }

  return {
    async callTool(name, args) {
      const message = await call(name, args).catch(async (error: unknown) => {
        if (!(error instanceof SessionGoneError)) throw error;
        session = undefined;
        return call(name, args);
      });
      if (message.error)
        throw new ProviderRefusedError(`${name}: ${message.error.message}`);
      const text = (message.result?.content ?? [])
        .map((item) => (item.type === "text" ? (item.text ?? "") : ""))
        .join("\n");
      if (message.result?.isError)
        throw new ProviderRefusedError(`${name}: ${text}`);
      return text;
    },
  };
}
