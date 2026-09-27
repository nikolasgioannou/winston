import { sql } from "drizzle-orm";
import { Hono } from "hono";
import type { ApiDeps, ApiEnv } from "../app.ts";

/** Liveness for the load balancer: the process answers and Postgres is reachable. */
export function healthRoutes({ db }: ApiDeps) {
  return new Hono<ApiEnv>().get("/", async (c) => {
    try {
      await db.execute(sql`select 1`);
      return c.json({ ok: true });
    } catch (error) {
      c.get("logger").error(
        { err: error },
        "health check: database unreachable",
      );
      return c.json({ ok: false }, 503);
    }
  });
}
