import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";

test("integration runner rejects remote Docker hosts before starting tests", () => {
  const runner = resolve(import.meta.dirname, "test-integration.mjs");

  for (const endpoint of ["tcp://production.invalid:2376", "ssh://production.invalid"]) {
    const result = spawnSync(process.execPath, [runner], {
      encoding: "utf8",
      env: { ...process.env, DOCKER_HOST: endpoint },
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /require a local Docker socket/);
  }
});
