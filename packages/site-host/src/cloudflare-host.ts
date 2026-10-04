import { createHash } from "node:crypto";
import { extname } from "node:path";
import { compatibilityDate, type SiteHost } from "./host.ts";

/**
 * Production's site host (docs/design.md §9a, docs/runbooks/sites.md):
 * Cloudflare's REST and GraphQL APIs with the backend's account token. Each
 * site is a user Worker in the dispatch namespace, its route an entry in the
 * routes map (Workers KV), its database a D1 database.
 */

const api = "https://api.cloudflare.com/client/v4";

/** Analytics queries span at most a week; a longer gap is counted from its last week. */
const maxUsageWindowMs = 7 * 24 * 60 * 60 * 1000;

export class CloudflareError extends Error {}

interface Envelope<T> {
  success: boolean;
  errors?: { code: number; message: string }[];
  result: T;
}

/** A static asset's content type, from its extension, so it's served with the right one. */
const contentTypes: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain",
  ".xml": "application/xml",
  ".pdf": "application/pdf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export function cloudflareSiteHost({
  apiToken,
  accountId,
  namespace,
  routesKvId,
  fetch: send = fetch,
}: {
  apiToken: string;
  accountId: string;
  namespace: string;
  routesKvId: string;
  /** For tests. */
  fetch?: typeof fetch;
}): SiteHost {
  const account = `${api}/accounts/${accountId}`;
  const scripts = `${account}/workers/dispatch/namespaces/${encodeURIComponent(namespace)}/scripts`;
  const routes = `${account}/storage/kv/namespaces/${routesKvId}/values`;
  const databases = `${account}/d1/database`;

  /** A call's result; a 404 is null when `missingIsFine` (deletes are idempotent). */
  async function call<T>(
    method: string,
    url: string,
    {
      json,
      body,
      token = apiToken,
      missingIsFine = false,
    }: {
      json?: unknown;
      body?: FormData | string;
      token?: string;
      missingIsFine?: boolean;
    } = {},
  ): Promise<T | null> {
    const response = await send(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(json === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(json === undefined
        ? body
          ? { body }
          : {}
        : { body: JSON.stringify(json) }),
    });
    if (response.status === 404 && missingIsFine) return null;
    const envelope = (await response
      .json()
      .catch(() => null)) as Envelope<T> | null;
    if (!response.ok || !envelope?.success)
      throw new CloudflareError(
        `Cloudflare: ${method} ${new URL(url).pathname} failed (${String(response.status)}): ${
          envelope?.errors?.map((error) => error.message).join("; ") ??
          "no details"
        }`,
      );
    return envelope.result;
  }

  /** Uploads a site's assets and returns the completion token the script's upload carries. */
  async function uploadAssets(
    script: string,
    assets: { path: string; content: Uint8Array }[],
  ) {
    const files = assets.map(({ path, content }) => {
      const base64 = Buffer.from(content).toString("base64");
      // Salted with the script, so sites never share each other's files.
      const hash = createHash("sha256")
        .update(`${script}:${base64}`)
        .digest("hex")
        .slice(0, 32);
      return { path, base64, hash, size: content.byteLength };
    });
    const session = await call<{ jwt: string; buckets: string[][] }>(
      "POST",
      `${scripts}/${script}/assets-upload-session`,
      {
        json: {
          manifest: Object.fromEntries(
            files.map(({ path, hash, size }) => [path, { hash, size }]),
          ),
        },
      },
    );
    if (!session) throw new CloudflareError("Cloudflare: no upload session");
    // Nothing new to upload: the session's token is already the completion token.
    let completion = session.jwt;
    for (const bucket of session.buckets) {
      const form = new FormData();
      for (const hash of bucket) {
        const file = files.find((candidate) => candidate.hash === hash);
        if (!file) continue;
        form.set(
          hash,
          new File([file.base64], hash, {
            type:
              contentTypes[extname(file.path).toLowerCase()] ??
              "application/octet-stream",
          }),
        );
      }
      const uploaded = await call<{ jwt?: string }>(
        "POST",
        `${account}/workers/assets/upload?base64=true`,
        { body: form, token: session.jwt },
      );
      if (uploaded?.jwt) completion = uploaded.jwt;
    }
    return completion;
  }

  return {
    kind: "cloudflare",

    async putScript(script, { modules, assets, databaseId }) {
      const [main] = modules;
      if (!main) throw new Error("a site's Worker needs a module");
      const assetsToken = assets.length
        ? await uploadAssets(script, assets)
        : undefined;
      const metadata = {
        main_module: main.name,
        compatibility_date: compatibilityDate,
        bindings: [
          ...(assetsToken ? [{ type: "assets", name: "ASSETS" }] : []),
          ...(databaseId
            ? [{ type: "d1", name: "DB", database_id: databaseId }]
            : []),
        ],
        ...(assetsToken
          ? {
              // Assets are served first; paths that aren't one go to the Worker.
              assets: {
                jwt: assetsToken,
                config: {
                  html_handling: "auto-trailing-slash",
                  not_found_handling: "none",
                },
              },
            }
          : {}),
      };
      const form = new FormData();
      form.set(
        "metadata",
        new Blob([JSON.stringify(metadata)], { type: "application/json" }),
      );
      for (const { name, content } of modules)
        form.set(
          name,
          new File([content], name, { type: "application/javascript+module" }),
        );
      await call("PUT", `${scripts}/${script}`, { body: form });
    },

    async deleteScript(script) {
      await call("DELETE", `${scripts}/${script}`, { missingIsFine: true });
    },

    async setRoute(name, route) {
      const url = `${routes}/${encodeURIComponent(name)}`;
      if (route) await call("PUT", url, { body: JSON.stringify(route) });
      else await call("DELETE", url, { missingIsFine: true });
    },

    async createDatabase(name) {
      const created = await call<{ uuid: string }>("POST", databases, {
        json: { name: `winston-${name}` },
      });
      if (!created) throw new CloudflareError("Cloudflare: no database");
      return created.uuid;
    },

    async deleteDatabase(databaseId) {
      await call("DELETE", `${databases}/${databaseId}`, {
        missingIsFine: true,
      });
    },

    async batchSql(databaseId, statements) {
      const results = await call<{ results: Record<string, unknown>[] }[]>(
        "POST",
        `${databases}/${databaseId}/query`,
        {
          json: {
            batch: statements.map(({ sql, params = [] }) => ({ sql, params })),
          },
        },
      );
      return (results ?? []).map((result) => result.results);
    },

    async usage(script, from, to) {
      const start = new Date(
        Math.max(from.getTime(), to.getTime() - maxUsageWindowMs),
      );
      const response = await send(`${api}/graphql`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          query: `query ($account: string!, $namespace: string!, $script: string!, $start: Time!, $end: Time!) {
            viewer { accounts(filter: { accountTag: $account }) {
              workersInvocationsAdaptive(limit: 10, filter: {
                dispatchNamespaceName: $namespace, scriptName: $script,
                datetime_geq: $start, datetime_lt: $end
              }) { sum { requests cpuTimeUs } }
            } }
          }`,
          variables: {
            account: accountId,
            namespace,
            script,
            start: start.toISOString(),
            end: to.toISOString(),
          },
        }),
      });
      const body = (await response.json()) as {
        data?: {
          viewer?: {
            accounts?: {
              workersInvocationsAdaptive?: {
                sum?: { requests?: number; cpuTimeUs?: number };
              }[];
            }[];
          };
        };
        errors?: { message: string }[] | null;
      };
      if (!response.ok || body.errors?.length)
        throw new CloudflareError(
          `Cloudflare analytics failed (${String(response.status)}): ${
            body.errors?.map((error) => error.message).join("; ") ??
            "no details"
          }`,
        );
      const rows =
        body.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
      return rows.reduce(
        (total, row) => ({
          requests: total.requests + (row.sum?.requests ?? 0),
          cpuMs: total.cpuMs + (row.sum?.cpuTimeUs ?? 0) / 1000,
        }),
        { requests: 0, cpuMs: 0 },
      );
    },

    async databaseSize(databaseId) {
      const database = await call<{ file_size: number }>(
        "GET",
        `${databases}/${databaseId}`,
      );
      return database?.file_size ?? 0;
    },
  };
}
