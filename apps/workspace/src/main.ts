import { chownSync } from "node:fs";
import { workspaceIdentitySchema } from "@winston/contracts/workspace";
import { createWorkspaceAuthority } from "./authority";
import { createWorkspaceHandler } from "./http";
import { openWorkspaceJournal } from "./journal";
import { createCommandRunner } from "./processes";
import { createCommandService } from "./commands";
import { createCommandHandler } from "./command-http";
import { openWorkspaceInbox } from "./inbox";
import { createInboxHandler } from "./inbox-http";

if (
  process.platform !== "linux" ||
  process.getuid?.() !== 0 ||
  process.env.WINSTON_RUNTIME_LOCKED !== "1"
) {
  throw new Error("Use the protected Linux workspace entrypoint.");
}
if (process.argv.slice(2).some((argument) => argument !== "--initialize")) {
  throw new Error("Unknown workspace runtime argument.");
}
const identity = workspaceIdentitySchema.parse({
  ownerId: process.env.WORKSPACE_OWNER_ID,
  workspaceId: process.env.WORKSPACE_ID,
});
const authority = createWorkspaceAuthority(process.env.WORKSPACE_AUTHORITY_ORIGIN ?? "");

// The entrypoint holds the volume lock. No previous execution process may outlive recovery.
const killed = Bun.spawnSync(["/usr/bin/pkill", "-KILL", "-u", "1000"], {
  env: {},
  stderr: "pipe",
});
if (killed.exitCode !== 0 && killed.exitCode !== 1)
  throw new Error("Cannot stop previous execution.");
const remaining = Bun.spawnSync(["/usr/bin/pgrep", "-u", "1000"], { env: {}, stdout: "pipe" });
if (remaining.exitCode !== 1) throw new Error("Previous execution has not stopped.");

process.umask(0o077);
const initialize = process.argv.includes("--initialize");
const journal = openWorkspaceJournal({ root: "/data", identity, initialize });
if (initialize) {
  chownSync(journal.home, 1000, 1000);
  journal.close();
  process.exit(0);
}
journal.recoverInterrupted();
const inbox = openWorkspaceInbox("/data");
const inboxHandler = createInboxHandler({
  identity,
  inbox,
  authorize: (token, transfer) => authority.inbox(token, transfer),
});
const runner = createCommandRunner({
  home: journal.home,
  logsRoot: "/data/control/commands",
  supervisorPath: "/app/supervisor.js",
});
const commands = createCommandService({ journal, runner, authority });
const commandHandler = createCommandHandler(identity, commands);
const inspectionHandler = createWorkspaceHandler({
  identity,
  journal,
  authorize: authority.inspect,
});

const server = Bun.serve({
  hostname: "0.0.0.0",
  port: 8080,
  maxRequestBodySize: 20_000_000,
  idleTimeout: 10,
  async fetch(request, server) {
    if (new URL(request.url).pathname === "/v1/inbox") {
      server.timeout(request, 65);
      return (await inboxHandler(request)) ?? new Response(null, { status: 404 });
    }
    return (await commandHandler(request)) ?? inspectionHandler(request);
  },
  error() {
    return Response.json({ error: "workspace_unavailable" }, { status: 503 });
  },
});

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await server.stop(true);
  await commands.close();
  journal.close();
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stop().catch(() => {
      process.exitCode = 1;
    });
  });
}
