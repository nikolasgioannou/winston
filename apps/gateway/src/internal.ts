import { timingSafeEqual } from "node:crypto";
import type { DbOrTx } from "@winston/db/client";
import { vms } from "@winston/db/schema";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { VmUnavailableError, VmUnreachableError, type Execs } from "./execs.ts";

const execBody = z.object({
  cmd: z.string().min(1),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), z.string()).default({}),
  timeoutMs: z.number().int().positive().max(3_600_000),
});

/**
 * The internal API `agents` uses to reach users' VMs (docs/design.md §15).
 * Authenticated with a shared secret and never exposed publicly (in
 * production, security groups restrict it).
 */
export function internalRoutes({
  db,
  secret,
  isConnected,
  execs,
}: {
  db: DbOrTx;
  secret: string;
  isConnected: (vmId: string) => boolean;
  execs: Execs;
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
    })
    .post("/vms/:userId/exec", async (c) => {
      const body = execBody.safeParse(
        await c.req.json().catch(() => undefined),
      );
      if (!body.success)
        return c.json(
          {
            error: {
              code: "invalid_request",
              message: z.prettifyError(body.error),
            },
          },
          400,
        );
      const [vm] = await db
        .select({ id: vms.id })
        .from(vms)
        .where(eq(vms.userId, c.req.param("userId")));
      if (!vm)
        return c.json(
          {
            error: { code: "not_found", message: "This user has no computer." },
          },
          404,
        );
      try {
        return c.json(await execs.run(vm.id, body.data));
      } catch (error) {
        if (error instanceof VmUnavailableError)
          return c.json(
            { error: { code: "vm_unavailable", message: error.message } },
            409,
          );
        if (error instanceof VmUnreachableError)
          return c.json(
            { error: { code: "vm_unreachable", message: error.message } },
            504,
          );
        throw error;
      }
    });
}
