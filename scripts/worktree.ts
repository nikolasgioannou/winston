/**
 * `bun run worktree setup|remove|prune`: gives a git worktree its own
 * databases, cleans them up before the worktree goes, and cleans up after
 * worktrees that went without it. docs/local-dev.md, Worktrees.
 *
 * Runs with --no-env-file: Bun would load .env.local before this rewrites it,
 * and the commands it starts would inherit those values over their own
 * --env-file, migrating the wrong database.
 */
import { $ } from "bun";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const marker = "# Worktree (bun run worktree setup):";
/** Marks the databases setup creates, so prune only ever drops those. */
const databaseComment = "winston worktree";

function log(message: string) {
  console.log(`  ${message}`);
}

function fail(message: string): never {
  console.error(`  ✗ ${message}`);
  process.exit(1);
}

const root = (await $`git rev-parse --show-toplevel`.text()).trim();
const gitDir = resolve(root, (await $`git rev-parse --git-dir`.text()).trim());
const commonDir = resolve(
  root,
  (await $`git rev-parse --git-common-dir`.text()).trim(),
);
const mainCheckout = dirname(commonDir);
const envPath = join(root, ".env.local");

/** A worktree's databases: winston_<folder name>, and its test database. */
function databasesOf(folder: string) {
  const slug = basename(folder)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");
  return { dev: `winston_${slug}`, test: `winston_${slug}_test` };
}
const databases = databasesOf(root);

/** setup and remove act on this worktree; never the main checkout's defaults. */
function requireWorktree() {
  if (gitDir === commonDir)
    fail("This is the main checkout. Run this inside a git worktree.");
  if (databases.dev === "winston_test")
    fail(
      "A worktree named test would share the main checkout's test database.",
    );
}

function envValue(env: string, name: string) {
  return new RegExp(`^${name}=(.*)$`, "m").exec(env)?.[1];
}

function withDatabase(url: string | undefined, name: string) {
  if (!url) fail("DATABASE_URL and TEST_DATABASE_URL must be in .env.local.");
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.href;
}

/**
 * Writes the worktree's .env.local: the main checkout's, pointed at the
 * worktree's own databases. A re-run picks up changes to the main checkout's.
 */
async function writeEnv() {
  const source = join(mainCheckout, ".env.local");
  if (!existsSync(source))
    fail(
      "The main checkout has no .env.local. Run ./scripts/setup.sh there first.",
    );
  const env = await readFile(source, "utf8");
  const overrides = {
    DATABASE_URL: withDatabase(envValue(env, "DATABASE_URL"), databases.dev),
    TEST_DATABASE_URL: withDatabase(
      envValue(env, "TEST_DATABASE_URL"),
      databases.test,
    ),
  };
  const kept = env
    .split("\n")
    .filter(
      (line) => !Object.keys(overrides).some((k) => line.startsWith(`${k}=`)),
    );
  while (kept.at(-1) === "") kept.pop();
  const block = Object.entries(overrides).map(([k, v]) => `${k}=${v}`);
  await writeFile(
    envPath,
    [...kept, "", `${marker} its own databases.`, ...block, ""].join("\n"),
  );
  log(
    `.env.local copied from the main checkout, with databases ${databases.dev} and ${databases.test}`,
  );
}

async function psql(sql: string, database = "postgres") {
  return (
    await $`docker compose exec -T postgres psql -U winston -d ${database} -tAc ${sql}`.text()
  ).trim();
}

function lines(output: string) {
  return output.split("\n").filter(Boolean);
}

/** Drops a worktree's databases, and first its users' local VMs. */
async function dropEnvironment({ dev, test }: { dev: string; test: string }) {
  const exists = await psql(
    `select 1 from pg_database where datname = '${dev}'`,
  );
  // A setup that stopped before migrating leaves no users table.
  if (exists && (await psql("select to_regclass('users')", dev))) {
    // apps/agents/src/vm/docker-provider.ts labels each VM with its user.
    for (const user of lines(await psql("select id from users", dev))) {
      const label = `label=winston.user=${user}`;
      const containers = lines(await $`docker ps -aq --filter ${label}`.text());
      if (containers.length) await $`docker rm -f ${containers}`.quiet();
      const volumes = lines(
        await $`docker volume ls -q --filter ${label}`.text(),
      );
      if (volumes.length) await $`docker volume rm ${volumes}`.quiet();
    }
  }
  for (const name of [dev, test])
    await psql(`drop database if exists "${name}" with (force)`);
  log(`removed ${dev} and ${test}, and their local VMs`);
}

/**
 * Removes the databases and VMs of worktrees whose folders are gone (archived
 * sessions, say). Only databases setup marked, and never a live worktree's.
 */
async function prune() {
  await $`docker compose up --detach --wait postgres`.quiet();
  const live = new Set<string>();
  const list = await $`git worktree list --porcelain`.text();
  for (const [, path] of list.matchAll(/^worktree (.+)$/gm))
    if (path && existsSync(path)) live.add(databasesOf(path).dev);
  const marked = lines(
    await psql(
      `select datname from pg_database where shobj_description(oid, 'pg_database') = '${databaseComment}'`,
    ),
  );
  const gone = marked.filter((dev) => !live.has(dev));
  for (const dev of gone) await dropEnvironment({ dev, test: `${dev}_test` });
  if (!gone.length) log("nothing left behind by removed worktrees");
}

async function setup() {
  requireWorktree();
  console.log(`Setting up worktree ${basename(root)}`);
  await prune();
  await writeEnv();
  await $`bun install --frozen-lockfile`.quiet();
  log("dependencies installed from bun.lock");
  if (
    !(await psql(
      `select 1 from pg_database where datname = '${databases.dev}'`,
    ))
  )
    await psql(`create database "${databases.dev}"`);
  await psql(`comment on database "${databases.dev}" is '${databaseComment}'`);
  await $`bun run db:migrate`.quiet();
  log(`database ${databases.dev} migrated (tests use ${databases.test})`);
  const env = await readFile(envPath, "utf8");
  if (envValue(env, "SEED_EMAIL")) {
    await $`bun run db:seed`.quiet();
    log("database seeded");
  }
  console.log(
    "Done. Run bun dev here once any other checkout's has stopped: one dev stack runs at a time.",
  );
}

async function remove() {
  requireWorktree();
  console.log(`Removing worktree ${basename(root)}'s environment`);
  await dropEnvironment(databases);
  console.log("Done. Now remove the worktree itself.");
}

const command = process.argv[2];
if (command === "setup") await setup();
else if (command === "remove") await remove();
else if (command === "prune") {
  console.log("Cleaning up after removed worktrees");
  await prune();
} else fail("Usage: bun run worktree setup|remove|prune");
