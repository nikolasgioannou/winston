import { describe, expect, test } from "bun:test";
import { cloudflareSiteHost } from "./cloudflare-host.ts";

const account = "acct123";
const base = `https://api.cloudflare.com/client/v4/accounts/${account}`;
const scripts = `${base}/workers/dispatch/namespaces/winston-sites/scripts`;

const ok = (result: unknown, status = 200) =>
  Response.json({ success: true, errors: [], result }, { status });

/** A multipart body's part, read from the raw body as it went over the wire. */
async function part(request: Request | undefined, name: string) {
  const raw = (await request?.clone().text()) ?? "";
  const match = new RegExp(
    `name="${name}"[^\\r\\n]*\\r\\nContent-Type: [^\\r\\n]*\\r\\n\\r\\n([\\s\\S]*?)\\r\\n--`,
  ).exec(raw);
  return match?.[1] ?? "";
}

/** A stand-in for Cloudflare's API: answers by route and records each request. */
function fakeApi(handle: (request: Request) => Response | undefined) {
  const requests: Request[] = [];
  const send = ((input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const request = new Request(url, init);
    requests.push(new Request(url, init));
    return Promise.resolve(
      handle(request) ??
        Response.json(
          { success: false, errors: [{ code: 7003, message: "no route" }] },
          { status: 404 },
        ),
    );
  }) as typeof fetch;
  const host = cloudflareSiteHost({
    apiToken: "token",
    accountId: account,
    namespace: "winston-sites",
    routesKvId: "kv1",
    fetch: send,
  });
  return { host, requests };
}

describe("the Cloudflare site host", () => {
  test("uploads assets through a session, then the script with its bindings", async () => {
    const { host, requests } = fakeApi((request) => {
      const url = request.url;
      if (url.endsWith("/scripts/site_1/assets-upload-session"))
        return ok({ jwt: "session-jwt", buckets: [["HASH"]] });
      if (url.endsWith("/workers/assets/upload?base64=true"))
        return ok({ jwt: "completion-jwt" }, 201);
      if (url === `${scripts}/site_1` && request.method === "PUT")
        return ok({});
      return undefined;
    });
    await host.putScript("site_1", {
      modules: [{ name: "worker.js", content: "export default {}" }],
      assets: [
        {
          path: "/index.html",
          content: new TextEncoder().encode("<h1>Hi</h1>"),
        },
      ],
      databaseId: "db-uuid",
    });

    const [session, upload, put] = requests;
    expect(session?.headers.get("authorization")).toBe("Bearer token");
    const manifest = (
      (await session?.json()) as {
        manifest: Record<string, { hash: string; size: number }>;
      }
    ).manifest;
    expect(Object.keys(manifest)).toEqual(["/index.html"]);
    expect(manifest["/index.html"]?.size).toBe(11);
    expect(manifest["/index.html"]?.hash).toMatch(/^[0-9a-f]{32}$/);

    // Uploads authenticate with the session's token, not the API token.
    expect(upload?.headers.get("authorization")).toBe("Bearer session-jwt");

    // On the wire, the module part says it's an ES module (parsing the form
    // back would guess its type from the filename instead).
    const raw = (await put?.clone().text()) ?? "";
    expect(raw).toMatch(
      /name="worker\.js"; filename="worker\.js"\r\nContent-Type: application\/javascript\+module/,
    );
    const metadata = JSON.parse(await part(put, "metadata")) as Record<
      string,
      unknown
    >;
    expect(metadata).toMatchObject({
      main_module: "worker.js",
      bindings: [
        { type: "assets", name: "ASSETS" },
        { type: "d1", name: "DB", database_id: "db-uuid" },
      ],
      assets: { jwt: "completion-jwt" },
    });
    expect(await part(put, "worker.js")).toBe("export default {}");
  });

  test("skips uploading when every asset is already there, and sends no assets for a Worker without any", async () => {
    const { host, requests } = fakeApi((request) => {
      if (request.url.endsWith("/assets-upload-session"))
        return ok({ jwt: "already-complete", buckets: [] });
      if (request.method === "PUT") return ok({});
      return undefined;
    });
    await host.putScript("site_1", {
      modules: [{ name: "worker.js", content: "x" }],
      assets: [{ path: "/a.txt", content: new Uint8Array([1]) }],
    });
    expect(
      requests.map((r) => new URL(r.url).pathname.split("/").pop()),
    ).toEqual(["assets-upload-session", "site_1"]);
    const metadata = JSON.parse(await part(requests[1], "metadata")) as {
      assets: { jwt: string };
    };
    expect(metadata.assets.jwt).toBe("already-complete");

    await host.putScript("site_2", {
      modules: [{ name: "worker.js", content: "x" }],
      assets: [],
    });
    const bare = JSON.parse(await part(requests[2], "metadata")) as Record<
      string,
      unknown
    >;
    expect(bare.assets).toBeUndefined();
    expect(bare.bindings).toEqual([]);
  });

  test("deletes are fine when the thing is already gone", async () => {
    const { host } = fakeApi(() => undefined);
    await host.deleteScript("site_1");
    await host.deleteDatabase("db-1");
    await host.setRoute("blog", null);
  });

  test("routes go to KV as JSON; databases are created, queried in a batch and measured", async () => {
    const { host, requests } = fakeApi((request) => {
      const url = request.url;
      if (url.startsWith(`${base}/storage/kv/namespaces/kv1/values/`))
        return ok(null);
      if (url === `${base}/d1/database` && request.method === "POST")
        return ok({ uuid: "db-uuid" });
      if (url === `${base}/d1/database/db-uuid/query`)
        return ok([{ results: [{ n: 1 }] }, { results: [] }]);
      if (url === `${base}/d1/database/db-uuid`) return ok({ file_size: 8192 });
      return undefined;
    });
    const route = {
      script: "site_1",
      ownerId: "usr_1",
      access: "private" as const,
      shareKeyHash: null,
      paused: false,
    };
    await host.setRoute("blog", route);
    expect(await requests[0]?.text()).toBe(JSON.stringify(route));

    expect(await host.createDatabase("site_1")).toBe("db-uuid");
    expect(await requests[1]?.json()).toEqual({ name: "winston-site_1" });

    expect(
      await host.batchSql("db-uuid", [
        { sql: "SELECT 1 AS n" },
        { sql: "INSERT INTO t VALUES (?)", params: ["x"] },
      ]),
    ).toEqual([[{ n: 1 }], []]);
    expect(await requests[2]?.json()).toEqual({
      batch: [
        { sql: "SELECT 1 AS n", params: [] },
        { sql: "INSERT INTO t VALUES (?)", params: ["x"] },
      ],
    });
    expect(await host.databaseSize("db-uuid")).toBe(8192);
  });

  test("usage sums the analytics rows for the script, CPU in milliseconds", async () => {
    const { host, requests } = fakeApi((request) =>
      request.url.endsWith("/graphql")
        ? Response.json({
            data: {
              viewer: {
                accounts: [
                  {
                    workersInvocationsAdaptive: [
                      { sum: { requests: 10, cpuTimeUs: 4000 } },
                      { sum: { requests: 5, cpuTimeUs: 1000 } },
                    ],
                  },
                ],
              },
            },
            errors: null,
          })
        : undefined,
    );
    const used = await host.usage(
      "site_1",
      new Date("2026-10-04T10:00:00Z"),
      new Date("2026-10-04T11:00:00Z"),
    );
    expect(used).toEqual({ requests: 15, cpuMs: 5 });
    const { variables } = (await requests[0]?.json()) as {
      variables: Record<string, string>;
    };
    expect(variables).toEqual({
      account,
      namespace: "winston-sites",
      script: "site_1",
      start: "2026-10-04T10:00:00.000Z",
      end: "2026-10-04T11:00:00.000Z",
    });
  });

  test("an error carries Cloudflare's message", async () => {
    const { host } = fakeApi(() =>
      Response.json(
        {
          success: false,
          errors: [{ code: 10000, message: "Authentication error" }],
        },
        { status: 403 },
      ),
    );
    const error = await host.createDatabase("x").catch((e: unknown) => e);
    expect(String(error)).toMatch(/Authentication error/);
  });
});
