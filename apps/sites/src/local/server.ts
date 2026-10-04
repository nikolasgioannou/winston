import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { parseSiteRoute } from "@winston/site-host/route";
import { Miniflare } from "miniflare";

/**
 * The newest date the pinned Miniflare's workerd accepts; production sites
 * use the same one (docs/design.md §9a).
 */
export const compatibilityDate = "2026-08-01";

/** Site Workers are named by their site's id. */
const scriptPattern = /^site_[a-z0-9]+$/;

export interface LocalSitesOptions {
  /** Where sites' files and Miniflare's state (routes, databases) live. */
  dir: string;
  domain: string;
  /** Where sites are served (`<name>.<domain>:<port>`). 0 picks one. */
  port: number;
  /** The admin API the backend's `localSiteHost` calls. 0 picks one. */
  adminPort: number;
  /** Where private sites send browsers to sign in: the local site. */
  webUrl: string;
  /** Verifies site passes (`sitePassPublicKey` of `SITES_PASS_KEY`). */
  passPublicKey: string;
}

interface Meta {
  modules: string[];
  databaseId?: string;
}

/** A site's Worker in Miniflare's options (its own types read as `any` here). */
interface SiteWorker {
  name: string;
  compatibilityDate: string;
  modulesRoot: string;
  modules: { type: "ESModule"; path: string }[];
  assets?: {
    directory: string;
    binding: string;
    routerConfig: { has_user_worker: boolean };
  };
  d1Databases?: Record<string, string>;
}

/** D1 as the admin API uses it (Miniflare types it with Workers types). */
interface D1 {
  prepare(sql: string): { bind(...params: unknown[]): unknown };
  batch(
    statements: unknown[],
  ): Promise<{ results: Record<string, unknown>[] }[]>;
}

/** The databases worker's binding for a database. */
const bindingOf = (databaseId: string) =>
  `DB_${databaseId.replaceAll("-", "")}`;

/**
 * The local stand-in for Workers for Platforms (docs/design.md §9a): every
 * site's Worker and the dispatch Worker in one Miniflare, behind a small admin
 * API. Miniflare can't run dispatch namespaces, so the dispatch Worker gets a
 * service binding per site, and changing a site rebuilds the whole Miniflare
 * from disk (about 50 ms; its `setOptions` fails under Bun).
 */
export async function startLocalSites(options: LocalSitesOptions) {
  const scriptsDir = join(options.dir, "scripts");
  await mkdir(scriptsDir, { recursive: true });
  // Every database created, so the admin API can reach each one through a
  // binding on its own small worker, whether or not a site binds it yet.
  const databasesFile = join(options.dir, "databases.json");
  const databases = async () =>
    (await Bun.file(databasesFile)
      .json()
      .catch(() => [])) as string[];

  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "../dispatch/local.ts")],
    target: "browser",
    format: "esm",
  });
  const output = built.outputs[0];
  if (!built.success || !output)
    throw new Error("couldn't build the dispatch Worker");
  const dispatchScript = await output.text();

  const siteWorkers = async (): Promise<SiteWorker[]> => {
    const scripts = (await readdir(scriptsDir)).filter((name) =>
      scriptPattern.test(name),
    );
    return Promise.all(
      scripts.map(async (script) => {
        const root = join(scriptsDir, script);
        const meta = (await Bun.file(join(root, "meta.json")).json()) as Meta;
        const assets = join(root, "assets");
        const hasAssets = (await readdir(assets).catch(() => [])).length > 0;
        return {
          name: script,
          compatibilityDate,
          modulesRoot: join(root, "modules"),
          modules: meta.modules.map((name) => ({
            type: "ESModule" as const,
            path: join(root, "modules", name),
          })),
          ...(hasAssets
            ? {
                assets: {
                  directory: assets,
                  binding: "ASSETS",
                  // Paths that aren't assets go to the site's Worker, as in production.
                  routerConfig: { has_user_worker: true },
                },
              }
            : {}),
          ...(meta.databaseId ? { d1Databases: { DB: meta.databaseId } } : {}),
        };
      }),
    );
  };

  const build = async () => {
    const sites = await siteWorkers();
    const mf = new Miniflare({
      host: "127.0.0.1",
      port: options.port,
      defaultPersistRoot: join(options.dir, "state"),
      kvPersist: true,
      d1Persist: true,
      // The first worker gets every request: the dispatch Worker.
      workers: [
        {
          name: "dispatch",
          compatibilityDate,
          modules: true,
          script: dispatchScript,
          bindings: {
            SITES_DOMAIN: options.domain,
            WEB_PUBLIC_URL: options.webUrl,
            SITES_PASS_PUBLIC_KEY: options.passPublicKey,
          },
          kvNamespaces: { ROUTES: "routes" },
          serviceBindings: Object.fromEntries(
            sites.map(({ name }) => [name, name]),
          ),
        },
        {
          name: "databases",
          compatibilityDate,
          modules: true,
          script:
            "export default { fetch: () => new Response(null, { status: 404 }) };",
          d1Databases: Object.fromEntries(
            (await databases()).map((id) => [bindingOf(id), id]),
          ),
        },
        ...sites,
      ],
    });
    await mf.ready;
    return mf;
  };

  let mf = await build();
  // A port of 0 is picked once, then kept across rebuilds.
  const port = Number((await mf.ready).port);
  options = { ...options, port };

  // One change at a time: each rebuild disposes the Miniflare the next uses.
  let queue = Promise.resolve();
  const serially = <T>(work: () => Promise<T>) => {
    const result = queue.then(work);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const rebuild = async () => {
    await mf.dispose();
    mf = await build();
  };
  // Miniflare types this with Workers types the repo doesn't install.
  const routes = () =>
    mf.getKVNamespace("ROUTES", "dispatch") as unknown as Promise<{
      put(key: string, value: string): Promise<void>;
      delete(key: string): Promise<void>;
    }>;

  const putScript = async (script: string, body: unknown) => {
    const upload = body as {
      modules: { name: string; content: string }[];
      assets: { path: string; base64: string }[];
      databaseId?: string;
    };
    if (upload.databaseId && !(await databases()).includes(upload.databaseId))
      throw new Error(`no database ${upload.databaseId}`);
    const root = join(scriptsDir, script);
    // Every path is checked before anything is written.
    const files = [
      ...upload.modules.map(({ name, content }) => ({
        target: inside(join(root, "modules"), name),
        content,
      })),
      ...upload.assets.map(({ path, base64 }) => ({
        target: inside(join(root, "assets"), path),
        content: Buffer.from(base64, "base64"),
      })),
    ];
    await rm(root, { recursive: true, force: true });
    for (const { target, content } of files) {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    await writeFile(
      join(root, "meta.json"),
      JSON.stringify({
        modules: upload.modules.map(({ name }) => name),
        ...(upload.databaseId ? { databaseId: upload.databaseId } : {}),
      } satisfies Meta),
    );
    await rebuild();
  };

  const createDatabase = async () => {
    const id = crypto.randomUUID();
    await writeFile(
      databasesFile,
      JSON.stringify([...(await databases()), id]),
    );
    await rebuild();
    return id;
  };

  const batch = async (databaseId: string, body: unknown) => {
    const { statements } = body as {
      statements: { sql: string; params?: unknown[] }[];
    };
    const db = (await mf.getD1Database(
      bindingOf(databaseId),
      "databases",
    )) as unknown as D1;
    const results = await db.batch(
      statements.map(({ sql, params = [] }) => db.prepare(sql).bind(...params)),
    );
    return results.map((result) => result.results);
  };

  const admin = Bun.serve({
    hostname: "127.0.0.1",
    port: options.adminPort,
    fetch: (request) =>
      serially(async () => {
        const [, kind, key = ""] = new URL(request.url).pathname.split("/");
        const name = decodeURIComponent(key);
        if (kind === "scripts" && scriptPattern.test(name)) {
          if (request.method === "PUT") {
            try {
              await putScript(name, await request.json());
            } catch (error) {
              return new Response((error as Error).message, { status: 400 });
            }
            return new Response(null, { status: 204 });
          }
          if (request.method === "DELETE") {
            await rm(join(scriptsDir, name), { recursive: true, force: true });
            await rebuild();
            return new Response(null, { status: 204 });
          }
        }
        if (kind === "routes" && name) {
          if (request.method === "PUT") {
            const route = parseSiteRoute(await request.json());
            if (!route) return new Response("bad route", { status: 400 });
            await (await routes()).put(name, JSON.stringify(route));
            return new Response(null, { status: 204 });
          }
          if (request.method === "DELETE") {
            await (await routes()).delete(name);
            return new Response(null, { status: 204 });
          }
        }
        if (kind === "databases" && request.method === "DELETE" && name) {
          const ids = await databases();
          if (ids.includes(name)) {
            // Its data stays in Miniflare's state folder, unreachable.
            await writeFile(
              databasesFile,
              JSON.stringify(ids.filter((id) => id !== name)),
            );
            await rebuild();
          }
          return new Response(null, { status: 204 });
        }
        if (kind === "databases" && request.method === "POST") {
          if (!name) return Response.json({ id: await createDatabase() });
          if (!(await databases()).includes(name))
            return new Response("no such database", { status: 404 });
          try {
            return Response.json({
              results: await batch(name, await request.json()),
            });
          } catch (error) {
            return new Response((error as Error).message, { status: 400 });
          }
        }
        return new Response("not found", { status: 404 });
      }),
  });

  return {
    url: `http://${options.domain}:${String(port)}`,
    adminUrl: `http://127.0.0.1:${String(admin.port)}`,
    /** Fetches a site page as a browser would, by its name (tests). */
    fetchSite: (name: string, path = "/", cookie?: string) =>
      fetch(`http://127.0.0.1:${String(port)}${path}`, {
        headers: {
          host: `${name}.${options.domain}`,
          ...(cookie ? { cookie } : {}),
        },
        redirect: "manual",
      }),
    stop: async () => {
      await admin.stop(true);
      await serially(() => mf.dispose());
    },
  };
}

/** `path` under `root`, refusing paths that would escape it. */
function inside(root: string, path: string) {
  const target = normalize(join(root, path));
  if (!target.startsWith(root + "/"))
    throw new Error(`path escapes the site: ${path}`);
  return target;
}
