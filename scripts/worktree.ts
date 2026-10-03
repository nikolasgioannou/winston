/**
 * `bun run worktree setup|remove`: makes a git worktree its own local
 * environment, with its own databases and ports, and cleans one up before the
 * worktree goes. docs/local-dev.md, Worktrees.
 *
 * Runs with --no-env-file: Bun would load .env.local before this rewrites it,
 * and the commands it starts would inherit those values over their own
 * --env-file, migrating the wrong database.
 */
import { $ } from "bun";
import { existsSync } from "node:fs";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const marker = "# Worktree (bun run worktree setup):";
const relayUrl = "http://localhost:3003";

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
// Never the main checkout: its databases and ports are the defaults.
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

/** Slot n uses api 30n0, gateway 30n1 and web 30n2; the main checkout is slot 0. */
function ports(slot: number) {
  const base = 3000 + slot * 10;
  return { api: base, gateway: base + 1, web: base + 2 };
}

function envValue(env: string, name: string) {
  return new RegExp(`^${name}=(.*)$`, "m").exec(env)?.[1];
}

async function slotsInUse() {
  const list = await $`git worktree list --porcelain`.text();
  const used = new Set<number>();
  for (const [, path] of list.matchAll(/^worktree (.+)$/gm)) {
    if (!path || path === root) continue;
    const file = join(path, ".env.local");
    if (!existsSync(file)) continue;
    const web = envValue(await readFile(file, "utf8"), "WEB_PUBLIC_URL");
    if (web) used.add((Number(new URL(web).port) - 3002) / 10);
  }
  return used;
}

function withDatabase(url: string | undefined, name: string) {
  if (!url) fail("DATABASE_URL and TEST_DATABASE_URL must be in .env.local.");
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.href;
}

async function writeEnv() {
  if (!existsSync(envPath)) {
    const source = join(mainCheckout, ".env.local");
    if (!existsSync(source))
      fail(
        "The main checkout has no .env.local. Run ./scripts/setup.sh there first.",
      );
    await copyFile(source, envPath);
    log("copied .env.local from the main checkout");
  }
  const env = await readFile(envPath, "utf8");
  if (env.includes(marker)) {
    log(".env.local already set up for this worktree");
    return;
  }
  const used = await slotsInUse();
  const slot = [1, 2, 3, 4, 5, 6, 7, 8, 9].find((n) => !used.has(n));
  if (slot === undefined)
    fail("All nine worktree port slots are taken. Remove a worktree first.");
  const port = ports(slot);
  const overrides = {
    DATABASE_URL: withDatabase(envValue(env, "DATABASE_URL"), databases.dev),
    TEST_DATABASE_URL: withDatabase(
      envValue(env, "TEST_DATABASE_URL"),
      databases.test,
    ),
    API_PORT: String(port.api),
    GATEWAY_PORT: String(port.gateway),
    GATEWAY_INTERNAL_URL: `http://127.0.0.1:${String(port.gateway)}`,
    GATEWAY_PUBLIC_URL: `ws://localhost:${String(port.gateway)}`,
    VM_GATEWAY_URL: `ws://host.docker.internal:${String(port.gateway)}`,
    WEB_PUBLIC_URL: `http://localhost:${String(port.web)}`,
    GOOGLE_OAUTH_REDIRECT_URL: relayUrl,
    // Webhooks reach only the main checkout's api.
    TUNNEL_NAME: "",
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
    [
      ...kept,
      "",
      `${marker} its own databases and ports (slot ${String(slot)}).`,
      ...block,
      "",
    ].join("\n"),
  );
  log(
    `slot ${String(slot)}: api ${String(port.api)}, gateway ${String(port.gateway)}, site http://localhost:${String(port.web)}`,
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
    `Done. bun dev serves ${envValue(env, "WEB_PUBLIC_URL") ?? ""}; sign in there.`,
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
