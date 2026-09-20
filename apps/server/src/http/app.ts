import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { errorResponse, RequestError } from "./errors";

export type Authority = "callback" | "owner" | "device" | "task";
export type Identity =
  | { kind: "callback"; provider: string }
  | { kind: "owner"; ownerId: string }
  | { kind: "device"; ownerId: string; deviceId: string }
  | { kind: "task"; ownerId: string; taskId: string; revision: number };

export type HttpEnvironment = { Variables: { requestId: string; identity: Identity } };
export type ApiRouter = Hono<HttpEnvironment>;
export type RequestLog = { requestId: string; status: number; durationMs: number };

type RouteGroup = {
  router: ApiRouter;
  authenticate: (request: Request) => Promise<Identity | null>;
};

export type ApiOptions = {
  groups?: Partial<Record<Authority, RouteGroup>>;
  readiness?: (signal: AbortSignal) => Promise<boolean>;
  log?: (entry: RequestLog) => void;
};

const prefixes = {
  callback: "/callbacks",
  owner: "/api/owner",
  device: "/api/devices",
  task: "/api/tasks",
} as const;

export function createApi(options: ApiOptions = {}) {
  const app = new Hono<HttpEnvironment>();
  const lifecycle = { started: false, draining: false };

  app.use("*", async (context, next) => {
    const started = performance.now();
    const requestId = crypto.randomUUID();
    context.set("requestId", requestId);
    context.header("X-Request-ID", requestId);
    context.header("Cache-Control", "no-store");

    if (lifecycle.draining) {
      return errorResponse("unavailable", requestId);
    }

    await next();

    // Never log headers, URL/query values, bodies, identities, or raw exceptions.
    options.log?.({
      requestId,
      status: context.res.status,
      durationMs: Math.round(performance.now() - started),
    });
  });

  app.use(
    "*",
    bodyLimit({
      maxSize: 1_048_576,
      onError: (context: Context<HttpEnvironment>) =>
        errorResponse("body_too_large", context.get("requestId")),
    }),
  );

  app.get("/health/live", (context) => context.json({ status: "alive" }));
  app.get("/health/ready", async (context) => {
    if (!lifecycle.started) {
      return errorResponse("unavailable", context.get("requestId"));
    }

    if (options.readiness) {
      const signal = AbortSignal.timeout(2000);
      const timeout = new Promise<boolean>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            resolve(false);
          },
          { once: true },
        );
      });

      const available = await Promise.race([
        Promise.resolve()
          .then(() => options.readiness?.(signal))
          .catch(() => false),
        timeout,
      ]);

      if (!available) {
        return errorResponse("unavailable", context.get("requestId"));
      }
    }

    return context.json({ status: "ready" });
  });

  for (const authority of Object.keys(prefixes) as Authority[]) {
    const group = options.groups?.[authority];
    const router = new Hono<HttpEnvironment>();

    router.use("*", async (context, next) => {
      const identity = await group?.authenticate(context.req.raw);

      if (!identity) {
        throw new RequestError("unauthorized");
      }

      if (identity.kind !== authority) {
        throw new RequestError("forbidden");
      }

      context.set("identity", identity);
      await next();
    });

    if (group) {
      router.route("/", group.router);
    }

    app.route(prefixes[authority], router);
  }

  app.notFound((context) => errorResponse("not_found", context.get("requestId")));
  app.onError((error, context) =>
    errorResponse(
      error instanceof RequestError ? error.code : "internal_error",
      context.get("requestId"),
    ),
  );

  return { app, lifecycle };
}
