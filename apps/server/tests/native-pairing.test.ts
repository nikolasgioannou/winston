import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";
import {
  deviceRegistrationSchema,
  registeredDeviceSchema,
} from "@winston/contracts/device-registry";

test.skipIf(process.platform !== "darwin")(
  "native pairing bounds responses, rejects redirects and never retries an uncertain exchange",
  async () => {
    let mode = "valid";
    let requests = 0;
    let redirected = 0;
    const device = registeredDeviceSchema.parse({
      id: "11111111-1111-4111-8111-111111111111",
      name: "Fixture Mac",
      platform: "macos",
      appVersion: "0.1.0",
      protocolVersion: 1,
      capabilities: [],
      revision: 0,
      isDefault: false,
      revoked: false,
      createdAt: "2030-01-01T00:00:00Z",
    });
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/redirected") {
          redirected += 1;
          return new Response(null, { status: 401 });
        }
        assert.equal(path, "/callbacks/devices/pair");
        assert.equal(new URL(request.url).search, "");
        assert.equal(request.method, "POST");
        assert.equal(request.headers.get("Authorization"), `Bearer wdp_${"b".repeat(43)}`);
        assert.equal(request.headers.get("Cookie"), null);
        assert.deepEqual(deviceRegistrationSchema.parse(await request.json()), {
          platform: "macos",
          appVersion: "0.1.0",
          protocolVersion: 1,
          capabilities: [],
        });
        requests += 1;
        if (mode === "rejected") return new Response(null, { status: 401 });
        if (mode === "redirect")
          return new Response(null, { status: 302, headers: { Location: "/redirected" } });
        if (mode === "stalled")
          return new Response(new ReadableStream({ start() {} }), { status: 201 });
        const result = {
          device: {
            ...device,
            ...(mode === "wrong-device" ? { id: "invalid" } : {}),
            ...(mode === "revoked" ? { revoked: true } : {}),
          },
          credential: mode === "wrong-credential" ? "invalid" : `wdi_${"a".repeat(43)}`,
        };
        return new Response(
          mode === "oversized"
            ? " ".repeat(16_385)
            : mode === "malformed"
              ? "{"
              : JSON.stringify(result),
          {
            status: 201,
            headers: { "Content-Type": "application/json", "Set-Cookie": "fixture=private" },
          },
        );
      },
    });
    try {
      for (const value of [
        "valid",
        "rejected",
        "redirect",
        "wrong-device",
        "revoked",
        "wrong-credential",
        "oversized",
        "malformed",
        "stalled",
      ]) {
        mode = value;
        const before = requests;
        const child = Bun.spawn(
          [
            "xcrun",
            "swift",
            "run",
            "--package-path",
            "packages/device-transport",
            "PairingFixture",
            `http://127.0.0.1:${String(server.port)}`,
            ...(value === "valid" ? [] : ["reject"]),
          ],
          {
            cwd: fileURLToPath(new URL("../../../", import.meta.url)),
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        try {
          const [code, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ]);
          assert.equal(code, 0, stderr);
          assert.match(
            stdout,
            value === "valid" ? /Native pairing passed/ : /Native pairing rejected/,
          );
          assert.equal(requests - before, 1);
        } finally {
          child.kill();
        }
      }
      assert.equal(redirected, 0);
    } finally {
      await server.stop(true);
    }
  },
  60_000,
);
