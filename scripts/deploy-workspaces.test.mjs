import assert from "node:assert/strict";
import { test } from "node:test";
import { deployWorkspaces } from "./deploy-workspaces.mjs";

function fixture() {
  const app = "fixture-workspace";
  const image = `registry.fly.io/${app}:verified-run`;
  const ids = ["1234567890abcd", "1234567890abce"];
  const machines = ids.map((id) => ({
    id,
    state: "started",
    config: {
      image: "previous",
      env: { WORKSPACE_OWNER_ID: "private-owner", WORKSPACE_ID: id },
      init: { exec: ["/usr/local/bin/workspace-entrypoint"] },
      mounts: [{ path: "/data", volume: `vol_${id}` }],
      services: [{ internal_port: 8080 }],
      restart: { policy: "always" },
    },
    image_ref: { digest: `sha256:${"a".repeat(64)}` },
  }));
  const calls = [];
  let fault = "";
  const run = (args) => {
    calls.push(args);
    if (args[1] === "list") return JSON.stringify(machines);
    const machine = machines.find((value) => value.id === args[2]);
    if (args[1] === "update") {
      if (fault === "update") throw new Error("Update unavailable");
      machine.config.image = args[args.indexOf("--image") + 1];
      machine.image_ref = {
        registry: "registry.fly.io",
        repository: app,
        tag: "verified-run",
        digest: `sha256:${"b".repeat(64)}`,
      };
      if (fault === "volume") machine.config.mounts[0].volume = "replacement";
      if (fault === "image") machine.image_ref.tag = "unexpected";
      return "";
    }
    if (args[1] === "exec") return fault === "health" ? "unavailable" : "workspace_ready";
    throw new Error("Unexpected CLI call");
  };
  return {
    machines,
    calls,
    options: { app, image, ids, run, pause: async () => {}, log: () => {} },
    fault(value) {
      fault = value;
    },
  };
}

test("workspace rollout preserves configuration and pins subsequent machines to the verified digest", async () => {
  const f = fixture();
  const before = structuredClone(f.machines.map((machine) => machine.config));
  const digest = await deployWorkspaces(f.options);
  assert.equal(digest, `sha256:${"b".repeat(64)}`);
  const updates = f.calls.filter((args) => args[1] === "update");
  assert.equal(updates.length, 2);
  assert.equal(
    updates[1][updates[1].indexOf("--image") + 1],
    `registry.fly.io/fixture-workspace@${digest}`,
  );
  for (const [index, machine] of f.machines.entries()) {
    assert.deepEqual({ ...machine.config, image: "previous" }, before[index]);
  }
});

test("invalid, duplicate, missing, bootstrap and stopped selections cannot trigger updates", async () => {
  for (const fault of ["duplicate", "missing", "bootstrap", "stopped", "foreign-image"]) {
    const f = fixture();
    if (fault === "duplicate") f.options.ids[1] = f.options.ids[0];
    if (fault === "missing") f.machines.pop();
    if (fault === "bootstrap") f.machines[1].config.init.exec.push("--initialize");
    if (fault === "stopped") f.machines[1].state = "stopped";
    if (fault === "foreign-image") f.options.image = "registry.fly.io/other:tag";
    await assert.rejects(deployWorkspaces(f.options));
    assert.equal(
      f.calls.some((args) => args[1] === "update"),
      false,
    );
  }
});

test("failed updates, volume changes, wrong images and failed health stop the rollout", async () => {
  for (const fault of ["update", "volume", "image", "health"]) {
    const f = fixture();
    f.fault(fault);
    await assert.rejects(deployWorkspaces(f.options));
    assert.equal(f.calls.filter((args) => args[1] === "update").length, 1);
  }
});

test("concurrent configuration changes abort before updating a workspace", async () => {
  const f = fixture();
  let reads = 0;
  const run = (args) => {
    if (args[1] === "list" && ++reads === 2) f.machines[0].config.env.WORKSPACE_ID = "changed";
    return f.options.run(args);
  };
  await assert.rejects(deployWorkspaces({ ...f.options, run }), /changed during deployment/);
  assert.equal(
    f.calls.some((args) => args[1] === "update"),
    false,
  );
});
