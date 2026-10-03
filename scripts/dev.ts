/**
 * `bun dev`: starts Postgres, migrates, then runs every local service with file
 * watching and one prefixed stream of output. Ctrl-C stops everything.
 * docs/local-dev.md.
 */
import { existsSync } from "node:fs";

interface Service {
  name: string;
  cwd: string;
  cmd: string[];
  /** A failure doesn't stop the other services (the tunnel needs per-developer setup). */
  optional?: boolean;
  /** A one-off job, not a server: finishing is expected. */
  task?: boolean;
}

// Restarts on changes to any file the service imports, including packages/*.
const watch = (entry: string) => [
  "bun",
  "--watch",
  "--no-clear-screen",
  "--env-file=../../.env.local",
  entry,
];

// Commands run directly, not through `bun run`, which would pass each signal on
// a second time. Add web here when it's created.
const services: Service[] = [
  { name: "api", cwd: "apps/api", cmd: watch("src/main.ts") },
  { name: "agents", cwd: "apps/agents", cmd: watch("src/main.ts") },
  { name: "gateway", cwd: "apps/gateway", cmd: watch("src/main.ts") },
  // Vite's dev server reloads the site itself (http://localhost:3002). Its
  // server code reads .env.local like the other services.
  {
    name: "web",
    cwd: "apps/web",
    cmd: ["bun", "--env-file=../../.env.local", "--bun", "vite", "dev"],
  },
  // Checks the seeded user's VM, provisions or replaces it as needed, and reports it until it's ready.
  {
    name: "vm",
    cwd: "apps/agents",
    cmd: ["bun", "--env-file=../../.env.local", "src/vm/seeded.ts", "ensure"],
    optional: true,
    task: true,
  },
  // Only with a tunnel set up: a worktree leaves it out (its webhooks go to
  // the main checkout's api).
  ...(process.env.TUNNEL_NAME
    ? [
        {
          name: "tunnel",
          cwd: ".",
          cmd: ["bun", "--env-file=.env.local", "scripts/tunnel.ts"],
          optional: true,
        },
      ]
    : []),
];

const colors = ["\x1b[36m", "\x1b[35m", "\x1b[33m", "\x1b[32m", "\x1b[34m"];
const reset = "\x1b[0m";
const width = Math.max(...services.map((s) => s.name.length));

function log(message: string) {
  console.log(`${"dev".padEnd(width)} │ ${message}`);
}

async function step(label: string, cmd: string[], hint: string) {
  log(label);
  const proc = Bun.spawn(cmd, { stdio: ["inherit", "inherit", "inherit"] });
  if ((await proc.exited) !== 0) {
    log(`${label.replace(/…$/, "")} failed. ${hint}`);
    process.exit(1);
  }
}

if (!existsSync(".env.local")) {
  log("No .env.local. Run ./scripts/setup.sh first.");
  process.exit(1);
}
if (!process.env.TUNNEL_NAME)
  log("No TUNNEL_NAME, so no webhook tunnel (see docs/local-dev.md).");
const setupHint = "Is Docker running? ./scripts/setup.sh checks everything.";
await step("Starting Postgres…", ["bun", "run", "db:up"], setupHint);
// Every checkout's site signs in through the shared OAuth relay
// (docs/local-dev.md, Worktrees); Compose starts it unless it's already running.
if (process.env.GOOGLE_OAUTH_REDIRECT_URL)
  await step(
    "Starting the OAuth relay…",
    ["docker", "compose", "up", "--detach", "--wait", "oauth-relay"],
    setupHint,
  );
await step("Migrating…", ["bun", "run", "db:migrate"], setupHint);

async function pipe(stream: ReadableStream<Uint8Array>, prefix: string) {
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of stream) {
    const lines = (buffered + decoder.decode(chunk, { stream: true })).split(
      "\n",
    );
    buffered = lines.pop() ?? "";
    for (const line of lines) process.stdout.write(`${prefix}${line}\n`);
  }
  if (buffered) process.stdout.write(`${prefix}${buffered}\n`);
}

let stopping = false;
const running = services.map((service, i) => {
  const color = colors[i % colors.length] ?? "";
  const prefix = `${color}${service.name.padEnd(width)}${reset} │ `;
  const proc = Bun.spawn(service.cmd, {
    cwd: service.cwd,
    env: { ...process.env, LOG_PRETTY: "true", FORCE_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    // Its own process group, so signals reach everything it starts (the
    // watcher's child, cloudflared) and nothing is left behind.
    detached: true,
  });
  const output = Promise.all([
    pipe(proc.stdout, prefix),
    pipe(proc.stderr, prefix),
  ]);
  const done = proc.exited.then(async (code) => {
    await output;
    if (stopping || (service.task && code === 0)) return;
    log(`${service.name} exited with code ${String(code)}`);
    if (!service.optional) stop(1);
  });
  return { proc, done };
});

let exitCode = 0;
function signalAll(signal: NodeJS.Signals) {
  for (const { proc } of running) {
    try {
      process.kill(-proc.pid, signal);
    } catch {
      // Already gone.
    }
  }
}

function stop(code: number) {
  if (stopping) {
    log("Forcing shutdown.");
    signalAll("SIGKILL");
    process.exit(1);
  }
  stopping = true;
  exitCode = code;
  log("Stopping… (Ctrl-C again to force)");
  signalAll("SIGTERM");
}

process.on("SIGINT", () => {
  stop(0);
});
process.on("SIGTERM", () => {
  stop(0);
});

await Promise.all(running.map((r) => r.done));
log("Stopped.");
process.exit(exitCode);
