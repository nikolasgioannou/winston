/**
 * `bun run worktree setup|remove`: gives a git worktree its own databases,
 * and cleans them up before the worktree goes. docs/local-dev.md, Worktrees.
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
// Never the main checkout: its databases are the defaults.
if (gitDir === commonDir)
  fail("This is the main checkout. Run this inside a git worktree.");
const mainCheckout = dirname(commonDir);
const envPath = join(root, ".env.local");

/** The worktree's databases: winston_<folder name>, and its test database. */
const slug = basename(root)
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "_");
const databases = { dev: `winston_${slug}`, test: `winston_${slug}_test` };
if (slug === "test")
  fail("A worktree named test would share the main checkout's test database.");

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

async function psql(sql: string) {
  return (
    await $`docker compose exec -T postgres psql -U winston -d postgres -tAc ${sql}`.text()
  ).trim();
}

async function setup() {
  console.log(`Setting up worktree ${basename(root)}`);
  await writeEnv();
  await $`bun install --frozen-lockfile`.quiet();
  log("dependencies installed from bun.lock");
  await $`docker compose up --detach --wait postgres`.quiet();
  const exists = await psql(
    `select 1 from pg_database where datname = '${databases.dev}'`,
  );
  if (!exists) await psql(`create database "${databases.dev}"`);
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
  console.log(`Removing worktree ${basename(root)}'s environment`);
  const dbExists = await psql(
    `select 1 from pg_database where datname = '${databases.dev}'`,
  );
  if (dbExists) {
    // Its users' local VMs (apps/agents/src/vm/docker-provider.ts labels them).
    const users =
      await $`docker compose exec -T postgres psql -U winston -d ${databases.dev} -tAc ${"select id from users"}`.text();
    for (const user of users.split("\n").filter(Boolean)) {
      const label = `label=winston.user=${user}`;
      const containers = (await $`docker ps -aq --filter ${label}`.text())
        .split("\n")
        .filter(Boolean);
      if (containers.length) await $`docker rm -f ${containers}`.quiet();
      const volumes = (await $`docker volume ls -q --filter ${label}`.text())
        .split("\n")
        .filter(Boolean);
      if (volumes.length) await $`docker volume rm ${volumes}`.quiet();
    }
    log("local VMs removed");
  }
  for (const name of [databases.dev, databases.test])
    await psql(`drop database if exists "${name}" with (force)`);
  log(`databases ${databases.dev} and ${databases.test} dropped`);
  console.log("Done. Now remove the worktree itself.");
}

const command = process.argv[2];
if (command === "setup") await setup();
else if (command === "remove") await remove();
else fail("Usage: bun run worktree setup|remove");
