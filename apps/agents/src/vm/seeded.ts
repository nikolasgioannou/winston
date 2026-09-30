/**
 * The seeded user's local VM, for development (docs/local-dev.md):
 *
 *   provision  request the VM, or retry it if it failed (bun dev runs the job)
 *   reset      queue a replacement: a new container from the current image,
 *              same data volume (§17 `replace`)
 *   shell      a login shell inside the container, as winston
 *   ensure     what bun dev runs at startup: check the image, request, retry
 *              or replace the VM as needed, and report its state until it's
 *              ready
 *
 * Other users' VMs come from signing up, like in production; this is for the
 * seeded one, whose user exists before any sign-in.
 */
import { stat } from "node:fs/promises";
import { createDb, type Db } from "@winston/db/client";
import { dbConfigSchema } from "@winston/db/config";
import { enqueue } from "@winston/db/queue";
import { users, vms } from "@winston/db/schema";
import { requestVm, retryFailedVm } from "@winston/db/vms";
import { provisionVmJob } from "@winston/domain/jobs";
import { loadConfig } from "@winston/shared/config";
import { eq } from "drizzle-orm";
import { z } from "zod";

const config = loadConfig(
  dbConfigSchema.extend({
    SEED_EMAIL: z.email(),
    VM_IMAGE: z.string().min(1).default("winston-vm:local"),
    GATEWAY_INTERNAL_URL: z.url().default("http://127.0.0.1:3001"),
    GATEWAY_INTERNAL_SECRET: z.string().min(1),
  }),
);
const repo = new URL("../../../../", import.meta.url).pathname;
const containerFor = (userId: string) => `winston-vm-${userId}`;
const say = (message: string) => {
  console.log(message);
};

const docker = (...args: string[]) => {
  const result = Bun.spawnSync(["docker", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return { ok: result.exitCode === 0, out: result.stdout.toString().trim() };
};

async function seededUser(db: Db) {
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, config.SEED_EMAIL));
  if (!user)
    throw new Error(
      `No user ${config.SEED_EMAIL}. Set the SEED_* values and run ./scripts/setup.sh.`,
    );
  return user.id;
}

const queueReplacement = (db: Db, userId: string) =>
  enqueue(db, provisionVmJob.type, {
    userId,
    dedupeKey: provisionVmJob.dedupeKey(userId),
    maxAttempts: provisionVmJob.maxAttempts,
    payload: { replace: true },
  });

/** Requests the user's VM if they have none, or retries a failed one. */
const provision = async (db: Db, userId: string) =>
  (await requestVm(db, userId)) || (await retryFailedVm(db, userId));

/** The newest change to anything baked into the image (its scripts and the binaries' sources). */
async function newestSource() {
  const files = Bun.spawnSync(
    [
      "git",
      "ls-files",
      "image",
      "apps/winstond",
      "apps/cli",
      "packages/domain",
      "packages/shared",
      "packages/vm-api",
    ],
    { cwd: repo, stdout: "pipe" },
  )
    .stdout.toString()
    .split("\n")
    .filter(Boolean);
  const times = await Promise.all(
    files.map((file) =>
      stat(`${repo}${file}`).then(
        (s) => s.mtimeMs,
        () => 0,
      ),
    ),
  );
  return Math.max(0, ...times);
}

async function ensure(db: Db) {
  const created = docker(
    "image",
    "inspect",
    "--format",
    "{{.Created}}",
    config.VM_IMAGE,
  );
  if (!created.ok) {
    say(
      `No local VM image yet. Build it with: bun run image:build:local (then bun run vm:provision).`,
    );
    return;
  }
  if ((await newestSource()) > Date.parse(created.out))
    say(
      `The VM image is older than its sources. Rebuild it with: bun run image:build:local && bun run vm:reset`,
    );

  const userId = await seededUser(db);
  const [vm] = await db.select().from(vms).where(eq(vms.userId, userId));
  const running =
    docker("inspect", "--format", "{{.State.Running}}", containerFor(userId))
      .out === "true";
  if (!vm || vm.state === "failed") {
    if (await provision(db, userId))
      say(
        vm
          ? `${vm.id} failed; provisioning it again.`
          : "No VM yet; provisioning one.",
      );
  } else if (!running && (vm.state === "ready" || vm.state === "unhealthy")) {
    say(`${vm.id}'s container is gone; replacing it.`);
    await queueReplacement(db, userId);
  }

  // Report the VM's state until it's ready (or give up after two minutes).
  let last = "";
  for (let waited = 0; waited < 120_000; waited += 2_000) {
    const status = await fetch(
      `${config.GATEWAY_INTERNAL_URL}/internal/vms/${userId}/status`,
      {
        headers: { Authorization: `Bearer ${config.GATEWAY_INTERNAL_SECRET}` },
      },
    )
      .then((response) =>
        response.ok
          ? (response.json() as Promise<{
              state: string;
              connected: boolean;
              winstondVersion: string | null;
              cliVersion: string | null;
            }>)
          : undefined,
      )
      .catch(() => undefined);
    const line = status
      ? `${vm?.id ?? "VM"} ${status.state}${status.connected ? "" : " (not connected)"}`
      : "waiting for the gateway…";
    if (line !== last) say(line);
    last = line;
    if (status?.state === "ready" && status.connected) {
      say(
        `winstond ${status.winstondVersion ?? "?"} · cli ${status.cliVersion ?? "none"}`,
      );
      return;
    }
    await Bun.sleep(2_000);
  }
  say(
    "The VM didn't become ready within two minutes. Check the agents and gateway output above.",
  );
}

const [command] = Bun.argv.slice(2);
const db = createDb(config.DATABASE_URL);
try {
  if (command === "ensure") await ensure(db);
  else if (command === "provision") {
    say(
      (await provision(db, await seededUser(db)))
        ? `Queued provisioning for ${config.SEED_EMAIL}'s VM; bun dev runs it.`
        : `${config.SEED_EMAIL}'s VM exists and hasn't failed; use vm:reset to replace it.`,
    );
  } else if (command === "reset") {
    await queueReplacement(db, await seededUser(db));
    say(`Queued a replacement for ${config.SEED_EMAIL}'s VM; bun dev runs it.`);
  } else if (command === "shell") {
    const shell = Bun.spawn(
      [
        "docker",
        "exec",
        "-it",
        containerFor(await seededUser(db)),
        "runuser",
        "-u",
        "winston",
        "--",
        "bash",
        "-l",
      ],
      {
        stdio: ["inherit", "inherit", "inherit"],
      },
    );
    process.exitCode = await shell.exited;
  } else {
    say("usage: seeded.ts provision | reset | shell | ensure");
    process.exitCode = 1;
  }
} finally {
  await db.$client.end();
}
