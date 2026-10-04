import { maxBundleBytes } from "@winston/site-host/bundle";
import type { InferResponseType } from "hono/client";
import { posix } from "node:path";
import { call, type ApiClient } from "../client.ts";
import type { Context, Resource } from "../commands.ts";
import { CliError } from "../errors.ts";
import { json, list, record } from "../output.ts";

/** Typed by the API itself (Hono RPC), so a change there breaks the build here. */
type Sites = ApiClient["v1"]["sites"];
type Listed = InferResponseType<Sites["$get"], 200>;
type Site = Listed["sites"][number];
type Shown = InferResponseType<Sites[":site"]["$get"], 200>;
type Deployed = InferResponseType<Sites["deploy"]["$post"], 200>;

const line = (site: Site) =>
  record(
    site.id,
    site.name,
    site.url,
    site.paused ? "paused" : site.access,
    site.version === null ? "not deployed" : `version ${String(site.version)}`,
    site.database ? "database" : undefined,
  );

/** A site folder on the VM: `~` and relative paths resolved, kept inside the home. */
function folder(path: string | undefined, files: Context["files"]) {
  if (!path)
    throw CliError.usage(
      "Which folder?",
      "Run winston site deploy <folder>, e.g. winston site deploy ~/sites/blog.",
    );
  const resolved = posix.resolve(
    files.cwd,
    path.startsWith("~") ? posix.join(files.home, path.slice(1)) : path,
  );
  if (!resolved.startsWith(`${files.home}/`))
    throw CliError.usage(
      `${path} is outside ${files.home}.`,
      "Build sites under your home folder, e.g. ~/sites/blog.",
    );
  return resolved;
}

/** What goes in a bundle: public/** (not hidden files), worker.js and migrations/*.sql. */
const deployable = (path: string) =>
  (path.startsWith("public/") &&
    !path.split("/").some((part) => part.startsWith("."))) ||
  path === "worker.js" ||
  /^migrations\/[^/]+\.sql$/.test(path);

/** Packs a site folder into a tar under ~/.cache, for the backend to read. */
async function pack(dir: string, name: string, files: Context["files"]) {
  const paths = (await files.list(dir)).filter(deployable).sort();
  if (!paths.some((path) => path.startsWith("public/") || path === "worker.js"))
    throw CliError.usage(
      `${dir} has nothing to deploy.`,
      "Put static files in public/, an API in worker.js (an ES module), or both; migrations go in migrations/*.sql.",
    );
  const entries = await Promise.all(
    paths.map(
      async (path) => [path, await files.read(`${dir}/${path}`)] as const,
    ),
  );
  const size = entries.reduce(
    (total, [, bytes]) => total + bytes.byteLength,
    0,
  );
  if (size > maxBundleBytes)
    throw CliError.usage(
      `${dir} is ${(size / 1024 / 1024).toFixed(1)} MB; a site can be at most 25 MB.`,
      "Leave out large files, or host them elsewhere and link to them.",
    );
  const tar = posix.join(
    files.home,
    ".cache/winston/sites",
    `${name}-${String(Date.now())}.tar`,
  );
  await files.write(
    tar,
    await new Bun.Archive(Object.fromEntries(entries)).bytes(),
  );
  return {
    tar,
    counts: {
      assets: paths.filter((path) => path.startsWith("public/")).length,
      worker: paths.includes("worker.js"),
      migrations: paths.filter((path) => path.startsWith("migrations/")).length,
    },
  };
}

export const site: Resource = {
  name: "site",
  description:
    "Websites and small apps you deploy to <name>.runwinston.app: static files, an API and a database",
  ids: ["site"],
  verbs: [
    {
      name: "deploy",
      summary:
        "Deploy a site folder (public/ for static files, worker.js for an API, migrations/*.sql for its database); a new site starts private to the user",
      usage: "<folder>",
      flags: [
        {
          name: "name",
          value: "<name>",
          description:
            "Its address, <name>.runwinston.app (default: the folder's name). Lowercase letters, digits and hyphens; first come, first served",
        },
      ],
      examples: [
        "winston site deploy ~/sites/blog",
        "winston site deploy ~/sites/trip --name lisbon-trip",
      ],
      run: async ({ client, flags, args, files }) => {
        const dir = folder(args[0], files);
        const name =
          typeof flags.name === "string"
            ? flags.name
            : posix.basename(dir).toLowerCase();
        const { tar, counts } = await pack(dir, name, files);
        let deployed: Deployed;
        try {
          deployed = await call<Deployed>(
            client.v1.sites.deploy.$post({ json: { path: tar, name } }),
          );
        } finally {
          await files.remove(tar);
        }
        if (flags.json === true) return json(deployed);
        const packed = [
          `${String(counts.assets)} static file${counts.assets === 1 ? "" : "s"}`,
          counts.worker ? "worker.js" : undefined,
          counts.migrations
            ? `${String(counts.migrations)} migration${counts.migrations === 1 ? "" : "s"}`
            : undefined,
        ].filter(Boolean);
        return [
          line(deployed.site),
          `Deployed ${packed.join(", ")}.`,
          deployed.migrated.length
            ? `Applied migrations: ${deployed.migrated.join(", ")}.`
            : undefined,
          // Every site is private until link sharing (bf7f34).
          "Private: only the user can open it, signed in to Winston.",
        ]
          .filter(Boolean)
          .join("\n");
      },
    },
    {
      name: "list",
      summary: "The user's sites, most recently deployed first",
      flags: [],
      examples: ["winston site list"],
      run: async ({ client, flags }) => {
        const listed = await call<Listed>(client.v1.sites.$get());
        return flags.json === true
          ? json(listed)
          : list(listed.sites.map(line));
      },
    },
    {
      name: "get",
      summary: "One site, by id or name",
      usage: "<site_id|name>",
      flags: [],
      examples: ["winston site get blog"],
      run: async ({ client, flags, args }) => {
        const [id] = args;
        if (!id)
          throw CliError.usage("Which site?", "Run winston site get <name>.");
        const shown = await call<Shown>(
          client.v1.sites[":site"].$get({ param: { site: id } }),
        );
        return flags.json === true ? json(shown) : line(shown.site);
      },
    },
  ],
};
