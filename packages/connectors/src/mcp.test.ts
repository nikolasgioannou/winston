import { describe, expect, test } from "bun:test";
import { ProviderRefusedError, ProviderUnavailableError } from "./errors.ts";
import { mcpClient } from "./mcp.ts";

interface Sent {
  method: string;
  token: string | null;
  session: string | null;
  version: string | null;
}

/**
 * A fake MCP server behind `fetch`: sessions, a token it accepts, and tools
 * answering with text. `reply` can change any one answer.
 */
function fakeServer({
  accept = "t1",
  sse = false,
  reply,
}: {
  accept?: string;
  sse?: boolean;
  reply?: (method: string, count: number) => Response | undefined;
} = {}) {
  const sent: Sent[] = [];
  let sessions = 0;
  let live: string | null = null;
  const fetch = ((_url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    const body = JSON.parse(init.body as string) as {
      id?: number;
      method: string;
      params?: { name?: string; arguments?: unknown };
    };
    sent.push({
      method: body.method,
      token: headers.get("authorization"),
      session: headers.get("mcp-session-id"),
      version: headers.get("mcp-protocol-version"),
    });
    const special = reply?.(
      body.method,
      sent.filter((s) => s.method === body.method).length,
    );
    if (special) return Promise.resolve(special);
    if (headers.get("authorization") !== `Bearer ${accept}`)
      return Promise.resolve(new Response("{}", { status: 401 }));
    if (body.method === "initialize") {
      live = `s${String(++sessions)}`;
      return Promise.resolve(
        Response.json(
          {
            jsonrpc: "2.0",
            id: body.id,
            result: { protocolVersion: "2025-06-18" },
          },
          { headers: { "mcp-session-id": live } },
        ),
      );
    }
    if (headers.get("mcp-session-id") !== live)
      return Promise.resolve(new Response("{}", { status: 404 }));
    if (body.method === "notifications/initialized")
      return Promise.resolve(new Response(null, { status: 202 }));
    const message = {
      jsonrpc: "2.0",
      id: body.id,
      result: {
        content: [
          { type: "text", text: JSON.stringify({ called: body.params?.name }) },
        ],
      },
    };
    return Promise.resolve(
      sse
        ? new Response(
            `event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\nevent: message\ndata: ${JSON.stringify(message)}\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          )
        : Response.json(message),
    );
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent, expire: () => (live = null) };
}

const url = "https://mcp.example.com/mcp";

describe("mcpClient", () => {
  test("starts a session once, then calls tools in it", async () => {
    const server = fakeServer();
    const client = mcpClient({
      url,
      accessToken: () => Promise.resolve("t1"),
      fetch: server.fetch,
    });
    expect(await client.callTool("ramp_get_transactions", { a: 1 })).toBe(
      '{"called":"ramp_get_transactions"}',
    );
    await client.callTool("ramp_get_bills", {});
    expect(server.sent.map((s) => [s.method, s.session])).toEqual([
      ["initialize", null],
      ["notifications/initialized", "s1"],
      ["tools/call", "s1"],
      ["tools/call", "s1"],
    ]);
    expect(server.sent.every((s) => s.version === "2025-06-18")).toBe(true);
  });

  test("reads the answer out of an event stream", async () => {
    const server = fakeServer({ sse: true });
    const client = mcpClient({
      url,
      accessToken: () => Promise.resolve("t1"),
      fetch: server.fetch,
    });
    expect(await client.callTool("ramp_token_info", {})).toBe(
      '{"called":"ramp_token_info"}',
    );
  });

  test("starts a new session when the server has forgotten the old one", async () => {
    const server = fakeServer();
    const client = mcpClient({
      url,
      accessToken: () => Promise.resolve("t1"),
      fetch: server.fetch,
    });
    await client.callTool("one", {});
    server.expire();
    expect(await client.callTool("two", {})).toBe('{"called":"two"}');
    expect(server.sent.filter((s) => s.method === "initialize")).toHaveLength(
      2,
    );
  });

  test("a refused token is traded for a fresh one, once", async () => {
    const server = fakeServer({ accept: "t2" });
    const asked: (string | undefined)[] = [];
    const client = mcpClient({
      url,
      accessToken: (rejected) => {
        asked.push(rejected);
        return Promise.resolve(rejected ? "t2" : "t1");
      },
      fetch: server.fetch,
    });
    expect(await client.callTool("one", {})).toBe('{"called":"one"}');
    expect(asked.slice(0, 2)).toEqual([undefined, "t1"]);

    const stuck = mcpClient({
      url,
      accessToken: () => Promise.resolve("bad"),
      fetch: fakeServer().fetch,
    });
    expect(
      await stuck.callTool("one", {}).catch((e: unknown) => e),
    ).toBeInstanceOf(ProviderRefusedError);
  });

  test("rate limits, server errors and no answer at all are worth retrying later", async () => {
    for (const status of [429, 503]) {
      const client = mcpClient({
        url,
        accessToken: () => Promise.resolve("t1"),
        fetch: fakeServer({
          reply: (method) =>
            method === "tools/call" ? new Response("", { status }) : undefined,
        }).fetch,
      });
      expect(
        await client.callTool("one", {}).catch((e: unknown) => e),
      ).toBeInstanceOf(ProviderUnavailableError);
    }
    const down = mcpClient({
      url,
      accessToken: () => Promise.resolve("t1"),
      fetch: (() =>
        Promise.reject(
          new Error("connection refused"),
        )) as unknown as typeof fetch,
    });
    expect(
      await down.callTool("one", {}).catch((e: unknown) => e),
    ).toBeInstanceOf(ProviderUnavailableError);
  });

  test("a tool error is refused with the tool's own words", async () => {
    const client = mcpClient({
      url,
      accessToken: () => Promise.resolve("t1"),
      fetch: fakeServer({
        reply: (method) =>
          method === "tools/call"
            ? Response.json({
                jsonrpc: "2.0",
                id: 2,
                result: {
                  isError: true,
                  content: [
                    {
                      type: "text",
                      text: "Input validation error: 'thoughts' is a required property",
                    },
                  ],
                },
              })
            : undefined,
      }).fetch,
    });
    const error = await client
      .callTool("ramp_get_requests_to_review", {})
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderRefusedError);
    expect((error as Error).message).toContain(
      "'thoughts' is a required property",
    );
  });
});
