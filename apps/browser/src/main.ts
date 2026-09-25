import { openBrowserService } from "./service";

const arguments_ = process.argv.slice(2);
if (arguments_.length > 1 || (arguments_.length === 1 && arguments_[0] !== "--initialize"))
  throw new Error("Unsupported browser service arguments.");

const health = { failed: false };
let stopping = false;
let service: Awaited<ReturnType<typeof openBrowserService>>;
let server: ReturnType<typeof Bun.serve> | undefined;
async function stop(code: number) {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 5000);
  try {
    await server?.stop(true);
    await service?.close();
  } catch {
    code = 1;
  } finally {
    clearTimeout(deadline);
    process.exit(code);
  }
}

try {
  service = await openBrowserService({
    initialize: arguments_[0] === "--initialize",
    onFailure: () => {
      health.failed = true;
      if (service) stop(1).catch(() => process.exit(1));
    },
  });
  if (health.failed) await stop(1);
  if (service) {
    server = Bun.serve({
      hostname: "0.0.0.0",
      port: 8080,
      fetch(request) {
        if (new URL(request.url).pathname !== "/health" || request.method !== "GET")
          return new Response(null, { status: 404 });
        try {
          if (health.failed || stopping) throw new Error("Unavailable");
          service?.healthy();
          return Response.json({ status: "ready", control: "frozen" });
        } catch {
          return new Response(null, { status: 503 });
        }
      },
    });
    process.once("SIGTERM", () => {
      stop(0).catch(() => process.exit(1));
    });
    process.once("SIGINT", () => {
      stop(0).catch(() => process.exit(1));
    });
    console.log(JSON.stringify({ event: "browser.ready", control: "frozen" }));
  }
} catch {
  console.error(JSON.stringify({ event: "browser.startup-failed" }));
  await stop(1);
}
