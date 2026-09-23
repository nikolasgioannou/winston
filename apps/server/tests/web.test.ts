import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { createApi } from "../src/http/app";

test("production frontend preserves API boundaries and only falls back for page routes", async () => {
  const root = await mkdtemp(join(tmpdir(), "winston-web-"));
  try {
    await mkdir(join(root, "assets"));
    await writeFile(join(root, "index.html"), "<!doctype html><title>Winston</title>");
    await writeFile(join(root, "assets", "app-hash.js"), "export {};");
    await writeFile(join(root, ".env"), "secret-canary");
    const { app } = createApi({ webRoot: root });
    for (const path of ["/", "/connections", "/activity/task"]) {
      const response = await app.request(path);
      assert.equal(response.status, 200);
      assert.ok((await response.text()).includes("<title>Winston</title>"));
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      assert.ok(
        response.headers.get("Content-Security-Policy")?.includes("frame-ancestors 'none'"),
      );
    }
    const asset = await app.request("/assets/app-hash.js");
    assert.equal(asset.status, 200);
    assert.ok(asset.headers.get("Cache-Control")?.includes("immutable"));
    for (const path of [
      "/assets/missing.js",
      "/assets/app-hash.js.map",
      "/.env",
      "/assets/%2e%2e/.env",
      "/__dev/design",
      "/api/missing",
      "/health/missing",
    ]) {
      const response = await app.request(path);
      assert.equal(response.status, 404, path);
      assert.ok(!(await response.text()).includes("<title>"));
    }
    assert.equal((await app.request("/api/owner/connections")).status, 401);
    assert.equal((await app.request("/connections", { method: "POST" })).status, 404);
    assert.equal(await (await app.request("/connections", { method: "HEAD" })).text(), "");
    assert.equal((await createApi().app.request("/")).status, 404);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
