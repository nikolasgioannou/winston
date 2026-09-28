import { timingSafeEqual } from "node:crypto";
import type { DbOrTx } from "@winston/db/client";
import { vms } from "@winston/db/schema";
import { eq } from "drizzle-orm";
import { Hono } from "hono";

/**
 * The internal API `agents` uses to reach users' VMs (docs/design.md §15).
 * Authenticated with a shared secret and never exposed publicly (in
 * production, security groups restrict it).
 */
export function internalRoutes({
  db,
  secret,
  isConnected,
}: {
  db: DbOrTx;
  secret: string;
  isConnected: (vmId: string) => boolean;
}) {
  const expected = Buffer.from(`Bearer ${secret}`);
  const authorized = (header: string | undefined) => {
    const given = Buffer.from(header ?? "");
    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  return new Hono()
    .basePath("/internal")
    .use(async (c, next) => {
      if (!authorized(c.req.header("Authorization")))
        return c.json({ error: "unauthorized" }, 401);
      await next();
    })
    .get("/vms/:userId/status", async (c) => {
      const [vm] = await db
        .select({
          id: vms.id,
          state: vms.state,
          lastSeenAt: vms.lastSeenAt,
          cliVersion: vms.cliVersion,
          winstondVersion: vms.winstondVersion,
        })
        .from(vms)
        .where(eq(vms.userId, c.req.param("userId")));
      if (!vm) return c.json({ error: "not_found" }, 404);
      return c.json({
        state: vm.state,
        connected: isConnected(vm.id),
        lastSeenAt: vm.lastSeenAt?.toISOString() ?? null,
        cliVersion: vm.cliVersion,
        winstondVersion: vm.winstondVersion,
      });
    });
}
