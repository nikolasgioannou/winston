/**
 * The VM-facing API (docs/design.md §15): what the `winston` CLI calls. It's
 * never exposed publicly. Requests arrive over a VM's websocket and the
 * gateway dispatches them in-process with `app.request()`, passing which
 * user's VM carried the request as `env.vmUserId`. Every request needs a
 * valid run token for that same user, so a token copied off the VM is
 * useless anywhere else.
 */
import type { DbOrTx } from "@winston/db/client";
import { users } from "@winston/db/schema";
import { apiError, apiErrors } from "@winston/domain/api-errors";
import { verifyRunToken } from "@winston/domain/run-token";
import { updateProfile } from "@winston/db/profile";
import { isTimeZone } from "@winston/shared/time";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { toApiFailure, type ConnectorDeps } from "./connections.ts";
import type { VmApiEnv } from "./env.ts";
import type { VmFiles } from "./files.ts";
import { accountRoutes } from "./accounts.ts";
import { calendarRoutes } from "./calendar.ts";
import { calendarWriteRoutes } from "./calendar-write.ts";
import { eventRoutes } from "./events.ts";
import { jevRoutes, type Jev } from "./jev.ts";
import { mailRoutes } from "./mail.ts";
import { mailWriteRoutes } from "./mail-write.ts";
import { taskRoutes, type TaskBrowser } from "./tasks.ts";
import { triggerRoutes } from "./triggers.ts";
import { z } from "zod";

const meUpdate = z.object({
  timezone: z
    .string()
    .refine(isTimeZone, "not an IANA time zone, e.g. America/New_York"),
});

export function createVmApi({
  db,
  runTokenSecret,
  connectors,
  vmFiles,
  browser,
  jev,
}: {
  db: DbOrTx;
  runTokenSecret: string;
  /** Handing a parked task's browser over (the gateway's handoff registry). */
  browser?: TaskBrowser;
  /** Writing files onto the user's VM (attachments): the gateway's file transfer. */
  vmFiles?: VmFiles;
  /** Mail and calendar (docs/design.md §5); absent where nothing is connected, as in some tests. */
  connectors?: ConnectorDeps;
  /** The browser's fast decision model (§5); absent without an OpenRouter key. */
  jev?: Jev | undefined;
}) {
  const app = new Hono<VmApiEnv>();

  app.use(async (c, next) => {
    const token = c.req.header("Authorization")?.match(/^Bearer (\S+)$/)?.[1];
    const run = token ? verifyRunToken(runTokenSecret, token) : undefined;
    // The token must be valid and belong to the user whose VM carried the request.
    if (run?.userId !== c.env.vmUserId)
      return c.json(
        apiError(
          "unauthorized",
          "This command isn't authorized.",
          "Run winston commands through your bash tool; they carry WINSTON_RUN_TOKEN automatically.",
        ),
        apiErrors.unauthorized.status,
      );
    c.set("run", { userId: run.userId, runId: run.runId, runKind: run.kind });
    await next();
  });

  app.onError((error, c) => {
    const failure = toApiFailure(error, connectors?.webPublicUrl);
    if (failure) return c.json(failure.body, failure.status);
    console.error(error);
    return c.json(
      apiError(
        "internal",
        "Something went wrong on Winston's side.",
        "Try again in a moment.",
      ),
      apiErrors.internal.status,
    );
  });
  app.notFound((c) =>
    c.json(
      apiError(
        "not_found",
        `There's no ${c.req.method} ${c.req.path}.`,
        "Run winston --help to see the commands.",
      ),
      apiErrors.not_found.status,
    ),
  );

  const selectMe = (userId: string) =>
    db
      .select({
        id: users.id,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
        timezone: users.timezone,
      })
      .from(users)
      .where(eq(users.id, userId));

  return app
    .get("/v1/me", async (c) => {
      const [me] = await selectMe(c.get("run").userId);
      if (!me)
        return c.json(
          apiError("not_found", "This user no longer exists."),
          apiErrors.not_found.status,
        );
      return c.json(me);
    })
    .patch("/v1/me", async (c) => {
      const body = meUpdate.safeParse(
        await c.req.json().catch(() => undefined),
      );
      if (!body.success)
        return c.json(
          apiError(
            "invalid_request",
            z.prettifyError(body.error),
            "Pass --timezone with an IANA zone like Europe/London.",
          ),
          apiErrors.invalid_request.status,
        );
      const userId = c.get("run").userId;
      // The same path as the site's, so Winston hears of the change either way.
      await updateProfile(
        db,
        userId,
        { timezone: body.data.timezone },
        "winston",
      );
      const [me] = await selectMe(userId);
      return c.json(me);
    })
    .route("/v1/accounts", accountRoutes({ db, connectors }))
    .route("/v1/mail", mailRoutes({ db, connectors, vmFiles }))
    .route("/v1/mail", mailWriteRoutes({ db, connectors, vmFiles }))
    .route("/v1/calendar", calendarRoutes({ db, connectors }))
    .route("/v1/calendar", calendarWriteRoutes({ db, connectors }))
    .route("/v1/tasks", taskRoutes({ db, browser }))
    .route("/v1/events", eventRoutes())
    .route("/v1/triggers", triggerRoutes({ db }))
    .route("/v1/jev", jevRoutes({ db, jev }));
}

export type { VmApiEnv } from "./env.ts";

/** The API's type, for the CLI's typed client (Hono RPC). */
export type VmApi = ReturnType<typeof createVmApi>;
