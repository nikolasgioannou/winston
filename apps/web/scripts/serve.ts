/**
 * The site's production server (docs/design.md §9): `Bun.serve` in front of
 * the TanStack Start build, the hosting option TanStack documents for Bun.
 * It serves the client build's hashed assets itself, answers `/health` for
 * the load balancer, and hands every other request to the built server.
 * The Docker build bundles this file, the built server included, into one
 * file (docker/web.Dockerfile).
 */
import { loadConfig } from "@winston/shared/config";
import { createLogger, logConfigSchema } from "@winston/shared/logger";
import { join, resolve, sep } from "node:path";
import { z } from "zod";

const config = loadConfig(
  logConfigSchema.extend({
    WEB_HOST: z.string().min(1).default("127.0.0.1"),
    WEB_PORT: z.coerce.number().int().positive().default(3002),
    /** The client build (`dist/client`); the image sets it. */
    WEB_CLIENT_DIR: z
      .string()
      .min(1)
      .default(new URL("../dist/client", import.meta.url).pathname),
  }),
);
const logger = createLogger("web", {
  level: config.LOG_LEVEL,
  pretty: config.LOG_PRETTY,
});

// The cast keeps TypeScript from resolving the build output, which may not
// exist yet (ESLint can't tell it matters); the bundler still sees a literal
// path and bundles it.
const { default: app } = (await import(
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  "../dist/server/server.js" as string
)) as { default: { fetch: (request: Request) => Promise<Response> } };

const clientDir = resolve(config.WEB_CLIENT_DIR);

/** A file from the client build, or undefined. Never escapes `clientDir`. */
async function clientFile(pathname: string) {
  const path = resolve(join(clientDir, decodeURIComponent(pathname)));
  if (!path.startsWith(clientDir + sep)) return undefined;
  const file = Bun.file(path);
  return (await file.exists()) ? file : undefined;
}

const server = Bun.serve({
  hostname: config.WEB_HOST,
  port: config.WEB_PORT,
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/health") return Response.json({ ok: true });
    if (pathname.startsWith("/assets/")) {
      const file = await clientFile(pathname);
      // Asset names carry a content hash, so they never change.
      if (file)
        return new Response(file, {
          headers: { "Cache-Control": "public, max-age=31536000, immutable" },
        });
    }
    return app.fetch(request);
  },
});

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) process.exit(1);
  stopping = true;
  logger.info({ signal }, "stopping");
  // Lets in-flight requests finish.
  await server.stop();
  logger.info("stopped");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

logger.info({ url: server.url.href }, "web listening");
