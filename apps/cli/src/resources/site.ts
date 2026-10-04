import { maxBundleBytes } from "@winston/site-host/bundle";
import type { InferResponseType } from "hono/client";
import { posix } from "node:path";
import { call, type ApiClient } from "../client.ts";
import type { Context, Resource } from "../commands.ts";
import { CliError } from "../errors.ts";
import { standardFlags } from "../flags.ts";
import { json, list, record } from "../output.ts";

/** Typed by the API itself (Hono RPC), so a change there breaks the build here. */
type Sites = ApiClient["v1"]["sites"];
type Listed = InferResponseType<Sites["$get"], 200>;
type Site = Listed["sites"][number];
type Shown = InferResponseType<Sites[":site"]["$get"], 200>;
type Deployed = InferResponseType<Sites["deploy"]["$post"], 200>;
type Shared = InferResponseType<Sites[":site"]["share"]["$post"], 200>;
type Unshared = InferResponseType<Sites[":site"]["unshare"]["$post"], 200>;
type Versions = InferResponseType<Sites[":site"]["versions"]["$get"], 200>;
type RolledBack = InferResponseType<Sites[":site"]["rollback"]["$post"], 200>;
type Deleted = InferResponseType<Sites[":site"]["$delete"], 200>;

const line = (site: Site) =>
  record(
    site.id,
    site.name,
    site.url,
    site.paused
      ? "paused"
      : site.access === "link"
        ? "shared by link"
        : "private",
    site.version === null ? "not deployed" : `version ${String(site.version)}`,
    site.database ? "database" : undefined,
  );

/** One site, with who can open it spelled out. */
const detail = (site: Site) =>
  [
    line(site),
    site.shareLink
      ? `Anyone with this link can open it: ${site.shareLink}`
      : "Private: only the user can open it, signed in to Winston.",
  ].join("\n");

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
        "Deploy a site folder: public/ for static files (served first), worker.js for an API (one ES module, `export default { fetch(request, env) }`, a Cloudflare Worker: env.ASSETS.fetch(request) serves public/, env.DB is the site's D1 SQLite database), migrations/*.sql for its schema, applied once each in name order. A new site starts private to the user",
      usage: "<folder>",
      flags: [
        {
          name: "name",
          value: "<name>",
          description:
            "Its address, <name>.runwinston.app (default: the folder's name). Lowercase letters, digits and hyphens; first come, first served",
        },
        standardFlags.dryRun,
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
            client.v1.sites.deploy.$post({
              json: { path: tar, name, dryRun: flags["dry-run"] === true },
            }),
          );
        } finally {
          await files.remove(tar);
        }
        if (flags.json === true) return json(deployed);
        if (!("site" in deployed)) return deployed.summary;
        const packed = [
          `${String(counts.assets)} static file${counts.assets === 1 ? "" : "s"}`,
          counts.worker ? "worker.js" : undefined,
          counts.migrations
            ? `${String(counts.migrations)} migration${counts.migrations === 1 ? "" : "s"}`
            : undefined,
        ].filter(Boolean);
        return [
          detail(deployed.site),
          `Deployed ${packed.join(", ")}.`,
          deployed.migrated.length
            ? `Applied migrations: ${deployed.migrated.join(", ")}.`
            : undefined,
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
        const shown = await call<Shown>(
          client.v1.sites[":site"].$get({
            param: { site: siteArg(args, "get") },
          }),
        );
        return flags.json === true ? json(shown) : detail(shown.site);
      },
    },
    {
      name: "versions",
      summary:
        "A site's deploys, newest first; the last 10 are kept for rollback",
      usage: "<site_id|name>",
      flags: [],
      examples: ["winston site versions blog"],
      run: async ({ client, flags, args }) => {
        const listed = await call<Versions>(
          client.v1.sites[":site"].versions.$get({
            param: { site: siteArg(args, "versions") },
          }),
        );
        if (flags.json === true) return json(listed);
        return list(
          listed.versions.map((version) =>
            record(
              `version ${String(version.number)}`,
              version.deployedAt,
              `${(version.size / 1024).toFixed(0)} KB`,
              version.current ? "current" : undefined,
            ),
          ),
        );
      },
    },
    {
      name: "rollback",
      summary:
        "Put an earlier version back (by default the one before the current). Restores code and files only: the database keeps its data and migrations",
      usage: "<site_id|name>",
      flags: [
        {
          name: "to",
          value: "<version>",
          description:
            "The version to go back to (winston site versions lists them)",
          integer: true,
        },
        standardFlags.dryRun,
      ],
      examples: [
        "winston site rollback blog",
        "winston site rollback blog --to 3",
      ],
      run: async ({ client, flags, args }) => {
        const rolledBack = await call<RolledBack>(
          client.v1.sites[":site"].rollback.$post({
            param: { site: siteArg(args, "rollback") },
            json: {
              ...(typeof flags.to === "number" ? { to: flags.to } : {}),
              dryRun: flags["dry-run"] === true,
            },
          }),
        );
        if (flags.json === true) return json(rolledBack);
        if (!("site" in rolledBack)) return rolledBack.summary;
        return [detail(rolledBack.site), rolledBack.note].join("\n");
      },
    },
    {
      name: "share",
      summary:
        "Share a site by link: anyone with the link can open it. Only when the user asks. Sharing again gives the same link",
      usage: "<site_id|name>",
      flags: [standardFlags.dryRun],
      examples: ["winston site share blog"],
      run: async ({ client, flags, args }) => {
        const shared = await call<Shared>(
          client.v1.sites[":site"].share.$post({
            param: { site: siteArg(args, "share") },
            json: { dryRun: flags["dry-run"] === true },
          }),
        );
        if (flags.json === true) return json(shared);
        return "site" in shared ? detail(shared.site) : shared.summary;
      },
    },
    {
      name: "unshare",
      summary:
        "Make a site private again: its share link and anyone who opened it stop working. Sharing it again makes a new link",
      usage: "<site_id|name>",
      flags: [standardFlags.dryRun],
      examples: ["winston site unshare blog"],
      run: async ({ client, flags, args }) => {
        const unshared = await call<Unshared>(
          client.v1.sites[":site"].unshare.$post({
            param: { site: siteArg(args, "unshare") },
            json: { dryRun: flags["dry-run"] === true },
          }),
        );
        if (flags.json === true) return json(unshared);
        return "site" in unshared ? detail(unshared.site) : unshared.summary;
      },
    },
    {
      name: "delete",
      summary:
        "Take a site down for good: its address stops working and its files, versions and database (with its data) are deleted; the name is freed. Confirm with the user first (--dry-run says what would go)",
      usage: "<site_id|name>",
      flags: [standardFlags.dryRun],
      examples: [
        "winston site delete blog --dry-run",
        "winston site delete blog",
      ],
      run: async ({ client, flags, args }) => {
        const deleted = await call<Deleted>(
          client.v1.sites[":site"].$delete({
            param: { site: siteArg(args, "delete") },
            json: { dryRun: flags["dry-run"] === true },
          }),
        );
        if (flags.json === true) return json(deleted);
        return "deleted" in deleted
          ? `Took ${deleted.name} down. Its address no longer answers, and the name is free.`
          : deleted.summary;
      },
    },
  ],
};

function siteArg(args: string[], verb: string) {
  const [id] = args;
  if (!id)
    throw CliError.usage("Which site?", `Run winston site ${verb} <name>.`);
  return id;
}
