import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";
import { deviceFileUploadSchema } from "@winston/contracts/artifacts";

test.skipIf(process.platform !== "darwin")(
  "native file uploads bind verified bytes to exact receipts and reject redirects and unbounded replies",
  async () => {
    const cwd = fileURLToPath(new URL("../../../", import.meta.url));
    const build = Bun.spawn(
      [
        "xcrun",
        "swift",
        "build",
        "--package-path",
        "apps/desktop-macos",
        "--product",
        "FileUploadFixture",
      ],
      { cwd, stdout: "pipe", stderr: "pipe" },
    );
    const [buildCode, buildOutput, buildError] = await Promise.all([
      build.exited,
      new Response(build.stdout).text(),
      new Response(build.stderr).text(),
    ]);
    assert.equal(buildCode, 0, buildOutput + buildError);
    const content = Buffer.alloc(180_000, 42);
    const digest = createHash("sha256").update(content).digest("hex");
    const cases = {
      ready: "ready",
      unknown: "uncertain",
      denied: "denied",
      conflict: "conflict",
      invalid_file: "invalidFile",
      wrongHash: "uncertain",
      wrongTransfer: "uncertain",
      extra: "uncertain",
      large: "uncertain",
      chunkedLarge: "uncertain",
      redirect: "uncertain",
      badType: "uncertain",
      forbidden: "uncertain",
      deadline: "deadline",
      invalidRequest: "invalidRequest",
      canceled: "canceled",
    };
    for (const [scenario, expected] of Object.entries(cases)) {
      const directory = await mkdtemp(join(tmpdir(), "winston-native-upload-"));
      const requests: {
        path: string;
        authorization: string | null;
        cookie: string | null;
        descriptor: unknown;
        bytes: Buffer;
      }[] = [];
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const path = new URL(request.url).pathname;
          const encoded = request.headers.get("X-Winston-File") ?? "";
          const bytes = Buffer.from(await request.arrayBuffer());
          requests.push({
            path,
            bytes,
            authorization: request.headers.get("Authorization"),
            cookie: request.headers.get("Cookie"),
            descriptor: encoded
              ? (JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown)
              : null,
          });
          if (path !== "/api/devices/files/upload") return new Response(null, { status: 403 });
          const descriptor = deviceFileUploadSchema.parse(requests.at(-1)?.descriptor);
          const base = {
            version: 1,
            status: "ready",
            transferId: descriptor.authority.transferId,
            artifactId: "66666666-6666-4666-8666-666666666666",
            revision: 1,
            size: content.length,
            sha256: digest,
          };
          if (scenario === "redirect")
            return new Response(null, { status: 307, headers: { Location: "/redirect-target" } });
          if (scenario === "forbidden") return new Response(null, { status: 403 });
          if (scenario === "badType")
            return new Response(JSON.stringify(base), {
              headers: { "Content-Type": "text/plain" },
            });
          if (scenario === "large")
            return new Response("x".repeat(10_000), {
              headers: { "Content-Type": "application/json" },
            });
          if (scenario === "chunkedLarge")
            return new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode("x".repeat(10_000)));
                  controller.close();
                },
              }),
              { headers: { "Content-Type": "application/json" } },
            );
          if (scenario === "canceled") {
            await cancelUpload();
            return new Response(new ReadableStream(), {
              headers: { "Content-Type": "application/json" },
            });
          }
          if (["unknown", "denied", "conflict", "invalid_file"].includes(scenario))
            return Response.json({ version: 1, status: scenario, transferId: base.transferId });
          if (scenario === "wrongHash") return Response.json({ ...base, sha256: "0".repeat(64) });
          if (scenario === "wrongTransfer")
            return Response.json({ ...base, transferId: base.artifactId });
          if (scenario === "extra")
            return Response.json({ ...base, url: "https://untrusted.invalid/" });
          return Response.json(base);
        },
      });
      const child = Bun.spawn(
        ["apps/desktop-macos/.build/debug/FileUploadFixture", directory, server.url.href, expected],
        { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
      );
      async function cancelUpload() {
        await child.stdin.write("cancel\n");
        await child.stdin.end();
      }
      const timer = setTimeout(() => {
        child.kill();
      }, 10_000);
      try {
        const [code, output, error] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        assert.equal(code, 0, `${scenario}: ${error}`);
        assert.match(output, /Native file upload checks passed/);
        assert.equal(
          requests.length,
          ["deadline", "invalidRequest"].includes(scenario) ? 0 : 1,
          scenario,
        );
        for (const request of requests) {
          assert.equal(request.path, "/api/devices/files/upload");
          assert.equal(request.authorization, `Bearer wdi_${"a".repeat(43)}`);
          assert.equal(request.cookie, null);
          assert.deepEqual(request.bytes, content);
          const descriptor = deviceFileUploadSchema.parse(request.descriptor);
          assert.equal(descriptor.size, content.length);
          assert.equal(descriptor.sha256, digest);
          assert.equal(
            descriptor.authority.session.deviceId,
            "11111111-1111-4111-8111-111111111111",
          );
          assert.equal(descriptor.authority.executionId, "44444444-4444-4444-8444-444444444444");
        }
      } finally {
        clearTimeout(timer);
        child.kill();
        await child.exited;
        await server.stop(true);
        await rm(directory, { recursive: true, force: true });
      }
    }
  },
  120_000,
);
