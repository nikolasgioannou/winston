import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { openBrowserService } from "../../src/service";

let failed = false;
const mode = process.argv[2];
const service = await openBrowserService({
  initialize: mode === "--initialize",
  onFailure: () => {
    failed = true;
  },
});
if (service) {
  const fixture = Bun.serve({
    hostname: "127.0.0.1",
    port: 9090,
    fetch(request) {
      if (new URL(request.url).pathname === "/login")
        return new Response("Synthetic login", {
          headers: {
            "set-cookie":
              "fixture_session=verified; HttpOnly; SameSite=Strict; Max-Age=3600; Path=/",
          },
        });
      return new Response(
        request.headers.get("cookie")?.includes("fixture_session=verified")
          ? "authenticated"
          : "anonymous",
      );
    },
  });
  try {
    assert.equal(service.gate.snapshot().phase, "frozen");
    const epoch = service.gate.snapshot().epoch;
    const grant = await service.gate.activateAgent({
      holder: crypto.randomUUID(),
      expiresAt: Date.now() + 60_000,
    });
    assert.equal(grant.phase, "agent");
    const access = { epoch: grant.epoch, holder: grant.holder };
    await service.gate.runAgent(access, async () => {
      const page = service.context.pages()[0];
      assert.ok(page);
      if (mode === "--write") await page.goto("http://127.0.0.1:9090/login");
      await page.goto("http://127.0.0.1:9090/status");
      assert.equal(await page.locator("body").innerText(), "authenticated");
      await page.goto("chrome://sandbox");
      const sandbox = await page.locator("body").innerText();
      assert.match(sandbox, /Layer 1 Sandbox\s+Namespace/);
      assert.match(sandbox, /PID namespaces\s+Yes/);
      assert.match(sandbox, /Network namespaces\s+Yes/);
      assert.match(sandbox, /Seccomp-BPF sandbox\s+Yes/);
    });
    await service.gate.takeOver(
      access,
      { holder: crypto.randomUUID(), expiresAt: Date.now() + 60_000 },
      new AbortController().signal,
    );
    await assert.rejects(service.gate.runAgent(access, () => Promise.resolve("stale observation")));
    let browsers = 0;
    let environments = 0;
    for (const pid of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
      try {
        const command = readFileSync(`/proc/${pid}/cmdline`, "utf8");
        if (!command.startsWith("/usr/lib/chromium/chromium\0")) continue;
        browsers++;
        assert.match(
          readFileSync(`/proc/${pid}/status`, "utf8"),
          /^Uid:\s+1000\s+1000\s+1000\s+1000$/m,
        );
        assert.ok(!command.includes("--no-sandbox"));
        assert.ok(!command.includes("--remote-debugging-port"));
        if (!command.includes("\0--type=")) {
          const inspect = Bun.spawn(
            [
              "setpriv",
              "--reuid=1000",
              "--regid=1000",
              "--clear-groups",
              "bun",
              "-e",
              `const value = require("node:fs").readFileSync(${JSON.stringify(`/proc/${pid}/environ`)}, "utf8"); if (!value.includes("DISPLAY=:99") || value.includes("BROWSER_BROKER_SECRET=")) process.exit(1);`,
            ],
            { env: { PATH: "/usr/local/bin:/usr/bin:/bin" }, stdout: "ignore", stderr: "ignore" },
          );
          assert.equal(await inspect.exited, 0);
          environments++;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    assert.ok(browsers > 0);
    assert.ok(environments > 0);
    const denied = Bun.spawn(
      [
        "setpriv",
        "--reuid=1000",
        "--regid=1000",
        "--clear-groups",
        "test",
        "-r",
        "/data/control/ownership.sqlite",
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    assert.notEqual(await denied.exited, 0);
    assert.equal(failed, false);
    console.log(JSON.stringify({ mode, epoch, passed: true }));
  } finally {
    await fixture.stop(true);
    await service.close();
  }
}
