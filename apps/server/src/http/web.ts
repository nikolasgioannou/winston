import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import type { HttpEnvironment } from "./app";
import { errorResponse } from "./errors";

export function createWebRouter(root: string) {
  const web = new Hono<HttpEnvironment>();
  web.use("*", async (context, next) => {
    const path = context.req.path;
    const reserved = /^\/(?:api|callbacks|health|__dev)(?:\/|$)/.test(path);
    if (reserved || path.includes("%") || path.split("/").some((part) => part.startsWith(".")))
      return errorResponse("not_found", context.get("requestId"));
    context.header("X-Content-Type-Options", "nosniff");
    context.header("Referrer-Policy", "no-referrer");
    context.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    await next();
  });
  web.get("/assets/*", async (context, next) => {
    if (!/\.(?:js|css|svg|png|jpg|jpeg|webp|ico|woff2?)$/.test(context.req.path))
      return errorResponse("not_found", context.get("requestId"));
    return serveStatic({
      root,
      onFound: (_path, ctx) => {
        ctx.header("Cache-Control", "public, max-age=31536000, immutable");
      },
    })(context, next);
  });
  web.get("*", async (context, next) => {
    if (context.req.path.startsWith("/assets/") || context.req.path.includes("."))
      return errorResponse("not_found", context.get("requestId"));
    return serveStatic({ root, path: "index.html" })(context, next);
  });
  return web;
}
