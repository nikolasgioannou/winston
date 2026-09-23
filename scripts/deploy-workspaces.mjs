import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

function fly(args) {
  try {
    return execFileSync("flyctl", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 360_000,
    });
  } catch {
    // Machine configuration can contain private identities. Keep raw CLI errors out of CI logs.
    throw new Error(`Fly ${args[0]} ${args[1]} failed. Inspect the machine before retrying.`);
  }
}

function retained(config) {
  const result = structuredClone(config);
  delete result.image;
  return result;
}

function validate(machine) {
  const config = machine?.config;
  if (
    machine?.state !== "started" ||
    !config ||
    config.mounts?.length !== 1 ||
    config.mounts[0].path !== "/data" ||
    !config.mounts[0].volume ||
    !config.env?.WORKSPACE_OWNER_ID ||
    !config.env.WORKSPACE_ID ||
    !isDeepStrictEqual(config.init?.exec, ["/usr/local/bin/workspace-entrypoint"])
  ) {
    throw new Error("Selected machine is not an initialized, running owner workspace.");
  }
}

export async function deployWorkspaces({
  app,
  image,
  ids,
  run = fly,
  pause = setTimeout,
  log = console.log,
}) {
  if (
    typeof app !== "string" ||
    !/^[a-z][a-z0-9-]+$/.test(app) ||
    typeof image !== "string" ||
    !image.startsWith(`registry.fly.io/${app}:`) ||
    !/^[a-zA-Z0-9_.-]+$/.test(image.split(":")[1] ?? "") ||
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.length > 100 ||
    ids.some((id) => typeof id !== "string" || !/^[a-f0-9]{14}$/.test(id)) ||
    new Set(ids).size !== ids.length
  )
    throw new Error("Invalid workspace deployment selection.");

  const list = () => JSON.parse(run(["machine", "list", "--app", app, "--json"]));
  const before = list();
  // Validate the whole selection before replacing any machine.
  for (const id of ids) validate(before.find((machine) => machine.id === id));
  let digest;
  for (const id of ids) {
    const previous = before.find((machine) => machine.id === id);
    const current = list().find((machine) => machine.id === id);
    if (!isDeepStrictEqual(current?.config, previous.config))
      throw new Error("Workspace configuration changed during deployment; no update attempted.");
    log(`Updating workspace ${id}; previous image ${previous.image_ref?.digest ?? "unknown"}.`);
    const update = [
      "machine",
      "update",
      id,
      "--app",
      app,
      "--image",
      digest ? `registry.fly.io/${app}@${digest}` : image,
      "--yes",
      "--wait-timeout",
      "300",
    ];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        run(update);
        break;
      } catch (error) {
        if (attempt === 2) throw error;
        await pause(5000 * (attempt + 1));
        const observed = list().find((machine) => machine.id === id);
        if (
          observed?.state !== "started" ||
          !isDeepStrictEqual(observed.config, previous.config) ||
          !isDeepStrictEqual(observed.image_ref, previous.image_ref)
        )
          throw new Error(
            "Workspace changed after an unsuccessful update; inspect before retrying.",
          );
        log(`Workspace ${id} remains unchanged; retrying the image update.`);
      }
    }
    let after;
    for (let attempt = 0; attempt <= 30; attempt += 1) {
      after = list().find((machine) => machine.id === id);
      if (!after?.config || !isDeepStrictEqual(retained(after.config), retained(previous.config)))
        throw new Error("Workspace configuration changed unexpectedly; inspect before proceeding.");
      if (after.state === "started") break;
      if (attempt < 30) await pause(1000);
    }
    validate(after);
    if (!isDeepStrictEqual(retained(after.config), retained(previous.config)))
      throw new Error("Workspace configuration changed unexpectedly; inspect before proceeding.");
    const reference = after.image_ref;
    if (
      reference?.registry !== "registry.fly.io" ||
      reference.repository !== app ||
      !/^sha256:[a-f0-9]{64}$/.test(reference.digest ?? "") ||
      (digest ? reference.digest !== digest : reference.tag !== image.split(":")[1])
    )
      throw new Error("Workspace image does not match the deployment.");
    digest = reference.digest;
    let healthy = false;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        const result = run([
          "machine",
          "exec",
          id,
          "--app",
          app,
          "--timeout",
          "10",
          'bun -e \'const r=await fetch("http://127.0.0.1:8080/health",{signal:AbortSignal.timeout(5000)});if(!r.ok||(await r.json()).status!=="ok")process.exit(1);console.log("workspace_ready")\'',
        ]);
        if (result.includes("workspace_ready")) {
          healthy = true;
          break;
        }
      } catch {
        // The runtime may still be opening and recovering its persistent journal.
      }
      await pause(1000);
    }
    if (!healthy) throw new Error("Workspace health verification failed; inspect before retrying.");
    log(`Workspace ${id} is healthy on ${digest}; persistent configuration preserved.`);
  }
  return digest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await deployWorkspaces({
    app: process.env.WORKSPACE_APP,
    image: process.env.WORKSPACE_IMAGE,
    ids: JSON.parse(process.env.WORKSPACE_MACHINE_IDS ?? "[]"),
  });
}
