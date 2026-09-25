import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";
import { deviceFileDownloadSchema } from "@winston/contracts/device-file-writes";

test.skipIf(process.platform !== "darwin")(
  "native downloads publish only verified approved bytes and join canceled transfers",
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
        "FileDownloadFixture",
      ],
      { cwd, stdout: "pipe", stderr: "pipe" },
    );
    const [buildCode, buildOutput, buildError] = await Promise.all([
      build.exited,
      new Response(build.stdout).text(),
      new Response(build.stderr).text(),
    ]);
    assert.equal(buildCode, 0, buildOutput + buildError);
    for (const scenario of [
      "ready",
      "streamed",
      "largeReady",
      "empty",
      "replace",
      "collision",
      "wrongHash",
      "wrongArtifact",
      "wrongRevision",
      "extra",
      "badHeader",
      "missingHeader",
      "badType",
      "forbidden",
      "redirect",
      "short",
      "large",
      "corrupt",
      "timeout",
      "deadline",
      "invalidRequest",
      "canceled",
    ]) {
      const directory = await mkdtemp(join(tmpdir(), "winston-native-download-"));
      const content = Buffer.alloc(
        scenario === "empty" ? 0 : scenario === "largeReady" ? 2_000_000 : 180_000,
        42,
      );
      const source = {
        artifactId: "66666666-6666-4666-8666-666666666666",
        revision: 2,
        size: content.length,
        sha256: createHash("sha256").update(content).digest("hex"),
      };
      const requests: {
        path: string;
        authorization: string | null;
        cookie: string | null;
        descriptor: unknown;
      }[] = [];
      let cancellationTimer: ReturnType<typeof setTimeout> | undefined;
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const path = new URL(request.url).pathname;
          requests.push({
            path,
            authorization: request.headers.get("Authorization"),
            cookie: request.headers.get("Cookie"),
            descriptor: await request.json(),
          });
          if (path !== "/api/devices/files/download") return new Response(null, { status: 403 });
          if (scenario === "redirect")
            return new Response(null, { status: 307, headers: { Location: "/redirect-target" } });
          if (scenario === "forbidden") return new Response(null, { status: 403 });
          const descriptor = { version: 1, source: { ...source } };
          if (scenario === "wrongHash") descriptor.source.sha256 = "0".repeat(64);
          if (scenario === "wrongArtifact")
            descriptor.source.artifactId = "77777777-7777-4777-8777-777777777777";
          if (scenario === "wrongRevision") descriptor.source.revision += 1;
          const headers = new Headers({
            "Content-Type": scenario === "badType" ? "text/plain" : "application/octet-stream",
            "Content-Length": String(content.length),
            "X-Winston-File": Buffer.from(
              JSON.stringify(
                scenario === "extra"
                  ? { ...descriptor, url: "https://untrusted.invalid" }
                  : descriptor,
              ),
            ).toString("base64url"),
          });
          if (scenario === "badHeader") headers.set("X-Winston-File", "x".repeat(5000));
          if (scenario === "missingHeader") headers.delete("X-Winston-File");
          if (scenario === "timeout" || scenario === "canceled")
            return new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(content.subarray(0, 100));
                  if (scenario === "canceled")
                    cancellationTimer = setTimeout(() => {
                      cancelDownload().catch(() => {
                        child.kill();
                      });
                    }, 100);
                },
              }),
              { headers },
            );
          const body =
            scenario === "corrupt"
              ? Buffer.alloc(content.length, 43)
              : scenario === "short"
                ? content.subarray(0, content.length - 1)
                : scenario === "large"
                  ? Buffer.concat([content, content])
                  : content;
          // Bun sets a fixed buffer's true Content-Length. An incomplete streamed body
          // instead exercises a disconnect with the originally promised length.
          if (scenario === "short" || scenario === "streamed")
            return new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(body);
                  controller.close();
                },
              }),
              { headers },
            );
          return new Response(body, { headers });
        },
      });
      const child = Bun.spawn(
        [
          "apps/desktop-macos/.build/debug/FileDownloadFixture",
          directory,
          server.url.href,
          scenario,
        ],
        { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
      );
      async function cancelDownload() {
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
        assert.match(output, /Native file download checks passed/);
        if (["deadline", "invalidRequest"].includes(scenario))
          assert.equal(requests.length, 0, scenario);
        else if (scenario === "collision") assert.ok(requests.length <= 1);
        else assert.equal(requests.length, 1, scenario);
        for (const request of requests) {
          assert.equal(request.path, "/api/devices/files/download");
          assert.equal(request.authorization, `Bearer wdi_${"a".repeat(43)}`);
          assert.equal(request.cookie, null);
          const input = deviceFileDownloadSchema.parse(request.descriptor);
          assert.equal(input.authority.session.deviceId, "11111111-1111-4111-8111-111111111111");
          assert.equal(input.authority.executionId, "44444444-4444-4444-8444-444444444444");
          assert.equal(input.authority.transferId, "33333333-3333-4333-8333-333333333333");
        }
      } finally {
        clearTimeout(timer);
        if (cancellationTimer) clearTimeout(cancellationTimer);
        child.kill();
        await child.exited;
        await server.stop(true);
        await rm(directory, { recursive: true, force: true });
      }
    }
  },
  120_000,
);
