import type { SiteScript } from "./host.ts";
import type { SiteMigration } from "./migrations.ts";

/**
 * A site's bundle (docs/design.md §9a): a tar the CLI packs from the site's
 * folder, holding `public/**` (static files), an optional `worker.js` (an ES
 * module, its API) and `migrations/*.sql` (its database's schema).
 */
export const maxBundleBytes = 25 * 1024 * 1024;

/** A site with no Worker of its own serves its static files and nothing else. */
const assetsOnlyWorker = `export default { fetch: (request, env) => env.ASSETS.fetch(request) };\n`;

export class BundleError extends Error {}

/** Reads a bundle into what's uploaded and what's migrated. Throws a `BundleError` for anything unexpected. */
export async function readBundle(bytes: Uint8Array): Promise<{
  script: SiteScript;
  migrations: SiteMigration[];
}> {
  if (bytes.byteLength > maxBundleBytes)
    throw new BundleError(
      `The site is ${megabytes(bytes.byteLength)}; the most is ${megabytes(maxBundleBytes)}.`,
    );
  let files: Map<string, Blob>;
  try {
    files = await new Bun.Archive(bytes).files();
  } catch {
    throw new BundleError("The bundle isn't a readable tar.");
  }
  const assets: SiteScript["assets"] = [];
  const migrations: SiteMigration[] = [];
  let worker: string | undefined;
  for (const [path, file] of files) {
    if (path.split("/").some((part) => part === ".." || part === ""))
      throw new BundleError(`The bundle has an unsafe path: ${path}`);
    if (path.startsWith("public/"))
      assets.push({
        path: path.slice("public".length),
        content: new Uint8Array(await file.arrayBuffer()),
      });
    else if (path === "worker.js") worker = await file.text();
    else if (/^migrations\/[^/]+\.sql$/.test(path))
      migrations.push({
        name: path.slice("migrations/".length),
        sql: await file.text(),
      });
    else
      throw new BundleError(
        `The bundle has ${path}; a site has only public/, worker.js and migrations/*.sql.`,
      );
  }
  if (assets.length === 0 && worker === undefined)
    throw new BundleError(
      "There's nothing to deploy: put static files in public/, an API in worker.js, or both.",
    );
  return {
    script: {
      modules: [{ name: "worker.js", content: worker ?? assetsOnlyWorker }],
      assets,
    },
    migrations,
  };
}

const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
